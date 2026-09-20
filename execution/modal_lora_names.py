"""
modal_lora_names.py - GPU service that reads handwritten Arabic names.

Replaces Azure's reading of the name cells. Measured on the frozen 400
held-out names (2026-08-24):

    Azure                    CER 0.143   26.0% full name
    adapter A alone          CER 0.049   57.1% full name   86.8% per name
    A + B + lexicon          CER 0.045   59.6% full name   88.2% per name

Both adapters run on one shared base model; the lexicon then picks whichever
candidate contains fewer words absent from our vocabulary. That signal is
strong: wrong predictions average 0.48 unknown words, correct ones 0.05.

Deploy:  modal deploy execution/modal_lora_names.py
Smoke:   modal run execution/modal_lora_names.py
"""
from __future__ import annotations

import modal

APP_NAME = "arabic-lora-names"
BASE     = "Qwen/Qwen2.5-VL-3B-Instruct"
PROMPT   = "اكتب الاسم المكتوب بخط اليد في هذه الصورة."
# Numeric cells are a different task. Asking the name prompt for an ID
# invites the model to answer with a name.
DIGITS_PROMPT = "اكتب الأرقام المكتوبة بخط اليد في هذه الصورة. اكتب الأرقام فقط بدون أي كلمات."

# Resolution is per-adapter and must match training - A was trained at 768
# image-token multiples, B at 1024. Using the wrong one degrades accuracy.
ADAPTERS = {"A": ("/adapters/A", 768), "B": ("/adapters/B", 1024)}

app      = modal.App(APP_NAME)
adapters = modal.Volume.from_name("arabic-htr-adapters")
hf_cache = modal.Volume.from_name("qwen-base-cache", create_if_missing=True)
# The training crops moved here when Supabase Storage went over quota. Approved
# crops -- which is what the frozen test set is made of -- no longer exist in
# the bucket, so evaluation reads them from the volume.
# Named crops_vol, not `crops`: a module-level `crops` shadows the crops list
# inside NameReader, and len() on a Volume fails in a place that looks nothing
# like the cause. Same collision as archive_crops.py's `archive`.
crops_vol = modal.Volume.from_name("arabic-htr-crops", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        "transformers==4.55.2",
        # Must match the version the adapters were saved with (adapter_config.json
        # records peft_version 0.20.0). On peft 0.14 the bare target_modules list
        # -- q/k/v/o/gate/up/down_proj -- also matches the vision encoder's MLP
        # blocks, so loading warns about missing adapter keys and applies nothing:
        # both adapters then return raw base Qwen, and agree on every crop.
        "peft==0.20.0",
        # torchao is deliberately NOT installed. transformers imports it
        # unconditionally when present (modeling_utils imports
        # Int4WeightOnlyConfig), and current torchao needs torch >= 2.11 for
        # torch.nn.functional.ScalingType -- on torch 2.5 that ImportError
        # surfaces as "cannot import name Qwen2_5_VLForConditionalGeneration",
        # which points nowhere near the real cause. Nothing here quantizes.
        "accelerate>=1.4.0",
        "pillow==11.1.0",
        "safetensors>=0.4.5",
    )
    .env({"HF_HOME": "/hf", "TOKENIZERS_PARALLELISM": "false"})
    # The vocabulary file only - the pipeline's other modules are not needed here.
    .add_local_dir("execution/data", remote_path="/vocab")
    # The pinned evaluation set, so honest scoring is available in-container.
    .add_local_dir("execution/testset", remote_path="/testset")
)


@app.cls(
    image=image,
    # bf16 is required -- a T4 produces multilingual garbage. Beyond that the
    # choice is about wall time, not cost: Modal bills per second, so a chip
    # that runs ~4x faster at ~4.9x the rate lands on roughly the same bill.
    #
    #   L4    $0.000222/s   baseline
    #   A100  $0.000583/s   ~2.5x faster
    #   H100  $0.001097/s   ~4x faster
    #
    # The bottleneck is the vision encoder reading each crop, which leans on
    # memory bandwidth more than raw compute, so treat those multipliers as
    # estimates until measured. H100s are also scarcer than L4s -- if cold
    # starts start queueing, that may cost more waiting than it saves.
    # A10G again since 2026-09-10, after a few hours on H100. Measured on the
    # same 14-name sheet: H100 56s cold / 27s warm, A10G 70s. Most of a cold
    # call is loading the 6 GB base model, which no GPU shortens, so the H100
    # saved ~14s per document at 3.6x the per-second price.
    gpu="A10G",
    volumes={"/adapters": adapters, "/hf": hf_cache, "/crops": crops_vol},
    secrets=[modal.Secret.from_name("claude-orchestrator-secrets")],
    timeout=1800,             # the first cold start pulls the 6 GB base model
    # Release the GPU as soon as a document is read (2s is Modal's minimum).
    # It was 240s: warm for the next document, but a lone document then paid
    # for four idle minutes -- $0.26 of a $0.32 name-reading bill on H100.
    # Each document's names go out in ONE call, so nothing waits on this.
    scaledown_window=2,
)
class NameReader:

    @modal.enter()
    def load(self):
        import re, json, torch
        from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
        from peft import PeftModel

        self.torch = torch

        # -- normalisation, identical to training -------------------------
        _diac = re.compile(r"[ً-ْـ]")

        def normalize(s: str) -> str:
            s = _diac.sub("", str(s))
            for a in "أإآٱ":
                s = s.replace(a, "ا")
            s = s.replace("ى", "ي").replace("ة", "ه")
            return re.sub(r"\s+", " ", s).strip()

        self.normalize = normalize
        self.junk = re.compile(r"^(الاسم[^:]*:|هذا هو[^:]*:|النص[^:]*:)\s*")

        # -- vocabulary ---------------------------------------------------
        # arabic_names_training.json was written with ocr_voter's normaliser,
        # which keeps ة and ى. The model's output goes through the training
        # normaliser, which folds them to ه and ي. Re-normalise the vocabulary
        # the model's way, or every such word would read as "unknown".
        vocab: set[str] = set()
        for fname in ("arabic_names_training.json", "arabic_names_learned.json"):
            try:
                with open("/vocab/" + fname, encoding="utf-8") as f:
                    for entry in json.load(f):
                        for tok in normalize(entry).split():
                            if len(tok) >= 2:
                                vocab.add(tok)
            except FileNotFoundError:
                pass
        self.vocab = frozenset(vocab)
        print("[NameReader] vocabulary: {:,} words".format(len(self.vocab)))

        # -- base model, shared by both adapters --------------------------
        base = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            BASE, torch_dtype=torch.bfloat16, device_map="cuda")

        model = None
        for tag, (path, _) in ADAPTERS.items():
            if model is None:
                model = PeftModel.from_pretrained(base, path, adapter_name=tag)
            else:
                model.load_adapter(path, adapter_name=tag)
        model.eval()
        self.model = model

        # A version mismatch between the saved adapter and the installed peft can
        # leave the LoRA weights unapplied without raising -- the model then just
        # returns base Qwen, which looks like a bad model rather than a bad load.
        # Fail loudly instead: every adapter must own non-zero weights.
        for tag in ADAPTERS:
            live = [m for n, m in model.named_modules() if n.endswith("lora_A." + tag)]
            if not live:
                raise RuntimeError(
                    "adapter " + tag + " loaded no LoRA modules -- check that the "
                    "installed peft matches peft_version in adapter_config.json")
            nonzero = sum(1 for m in live if m.weight.abs().sum().item() > 0)
            print("[NameReader] adapter {}: {} LoRA modules, {} non-zero".format(
                tag, len(live), nonzero))
            if nonzero == 0:
                raise RuntimeError("adapter " + tag + " has all-zero LoRA weights")

        # One processor per adapter - they differ only in max_pixels.
        self.processors = {
            tag: AutoProcessor.from_pretrained(
                BASE, min_pixels=256 * 28 * 28, max_pixels=pix * 28 * 28)
            for tag, (_, pix) in ADAPTERS.items()
        }
        # Batched generation requires LEFT padding. With the default right
        # padding the short prompts are followed by pad tokens, so slicing off
        # input_ids.shape[1] cuts into the answer instead of the prompt -- the
        # output is quietly wrong rather than an error.
        for proc in self.processors.values():
            proc.tokenizer.padding_side = "left"
        print("[NameReader] ready - adapters " + ", ".join(ADAPTERS))

    # -- helpers ----------------------------------------------------------
    def _upscale(self, img):
        from PIL import Image
        w, h = img.size
        if h >= 224:
            return img
        return img.resize((max(1, int(w * 224 / h)), 224), Image.LANCZOS)

    def _generate(self, proc, chunk: list, beams: int = 4, prompt: str = None) -> list:
        """
        One GPU call for a group of crops.

        beams stays at 4. Greedy decoding is not the speed win it looks like --
        measured on 40 held-out names, beams=1 ran 215s against 234s for
        beams=4, an 8% saving, and cost 1.9 points of per-name accuracy
        (87.3% vs 89.2%). The answers are only ~8 tokens, so beam search is
        cheap; nearly all the time is the vision encoder reading the crop,
        which is identical either way.
        """
        _prompt = prompt or PROMPT
        msgs = [[{"role": "user", "content": [{"type": "image", "image": im},
                                              {"type": "text", "text": _prompt}]}]
                for im in chunk]
        texts = [proc.apply_chat_template(m, tokenize=False, add_generation_prompt=True)
                 for m in msgs]
        inp = proc(text=texts, images=chunk, return_tensors="pt",
                   padding=True).to(self.model.device)
        with self.torch.no_grad():
            gen = self.model.generate(
                **inp, max_new_tokens=32, do_sample=False, num_beams=beams,
                **({"early_stopping": True} if beams > 1 else {}))
        # Left padding makes this slice correct for every row in the batch.
        answers = proc.batch_decode(gen[:, inp.input_ids.shape[1]:],
                                    skip_special_tokens=True)
        return [self.normalize(
            self.junk.sub("", a.strip()).strip('"').split("\n")[0]) for a in answers]

    def _run(self, tag: str, images: list, batch: int = 1, beams: int = 4,
             prompt: str = None, use_adapter: bool = True) -> list:
        """
        Read every crop with one adapter, `batch` crops per GPU call.

        batch stays at 1 on purpose. Batching looks like free throughput -- a
        single small crop leaves most of the GPU idle -- but verify_batching on
        16 held-out crops found only 7 answers unchanged at batch 8:

            one at a time  'صالح محمد صالح ابو سريه'   batched  'صال'
            one at a time  'نور حسام جمعه برهوم'        batched  'ن السطر'

        Text padding was not the cause (padding_side is left). Qwen2.5-VL packs
        a batch's images into one pixel_values tensor described by
        image_grid_thw, and crops of differing sizes stop lining up with their
        rows, so each row reads partly from another crop's features. It fails
        silently -- plausible Arabic, wrong name.

        It was only 1.69x anyway. Re-run batchcheck after a transformers upgrade
        before trusting any batch > 1.
        """
        proc = self.processors[tag]
        self.model.set_adapter(tag)
        out = []
        i = 0
        while i < len(images):
            size = max(1, batch)
            while True:
                try:
                    if use_adapter:
                        out += self._generate(proc, images[i:i + size], beams, prompt)
                    else:
                        # Base Qwen with no LoRA. The adapters were trained on
                        # names; on a digit cell they may pull towards one.
                        with self.model.disable_adapter():
                            out += self._generate(proc, images[i:i + size], beams, prompt)
                    break
                except self.torch.cuda.OutOfMemoryError:
                    self.torch.cuda.empty_cache()
                    if size == 1:
                        raise
                    size = max(1, size // 2)
                    print("[NameReader] OOM, retrying at batch {}".format(size))
            i += size
        return out

    def _unknown(self, name: str) -> int:
        return sum(1 for w in name.split() if w not in self.vocab)

    def _prepare(self, raw: bytes):
        import io
        from PIL import Image
        return self._upscale(Image.open(io.BytesIO(raw)).convert("RGB"))

    def _fetch(self, limit: int, frozen: bool):
        """
        Pull labelled crops from Supabase, inside the container.

        frozen=True reads the pinned test set the adapters never trained on --
        the only honest source for a measurement.
        """
        import csv, json, os, urllib.request

        url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        H = {"apikey": key, "Authorization": "Bearer " + key}

        rows = []
        if frozen:
            with open("/testset/frozen_test_400.csv", encoding="utf-8") as f:
                ids = [r["id"] for r in csv.DictReader(f)][:limit]
            for i in range(0, len(ids), 50):          # keep the URL short
                q = (url + "/rest/v1/training_dataset?select=id,label,crop_path"
                     "&id=in.(" + ",".join(ids[i:i + 50]) + ")")
                rows += json.load(urllib.request.urlopen(
                    urllib.request.Request(q, headers=H), timeout=90))
        else:
            q = (url + "/rest/v1/training_dataset?select=id,label,crop_path"
                 "&status=eq.approved&order=created_at.desc&limit=" + str(limit))
            rows = json.load(urllib.request.urlopen(
                urllib.request.Request(q, headers=H), timeout=90))

        import pathlib

        crop_bytes, labels = [], []
        from_volume = from_bucket = 0
        for r in rows:
            if not r.get("crop_path"):
                continue
            # Volume first. Approved crops were removed from Supabase Storage
            # once it went over quota, so the bucket is no longer the source of
            # truth for them -- and reading locally is faster besides.
            local = pathlib.Path("/crops") / r["crop_path"]
            if local.exists() and local.stat().st_size > 0:
                crop_bytes.append(local.read_bytes())
                labels.append(r["label"])
                from_volume += 1
                continue
            try:
                req = urllib.request.Request(
                    url + "/storage/v1/object/sign/training_crops/" + r["crop_path"],
                    data=json.dumps({"expiresIn": 1800}).encode(),
                    headers=dict(H, **{"Content-Type": "application/json"}),
                    method="POST")
                signed = json.load(urllib.request.urlopen(req, timeout=90))["signedURL"]
                crop_bytes.append(urllib.request.urlopen(
                    url + "/storage/v1" + signed, timeout=120).read())
                labels.append(r["label"])
                from_bucket += 1
            except Exception as e:
                # One unreadable crop must not fail the whole evaluation, but
                # a silent skip would quietly shrink the test set -- so say so.
                print("  skipped {}: {}".format(r["crop_path"], str(e)[:60]))
        print("[NameReader] crops: {} from volume, {} from bucket".format(
            from_volume, from_bucket))
        print("[NameReader] fetched {} crops (frozen={})".format(len(crop_bytes), frozen))
        return crop_bytes, labels

    # -- public entry point -----------------------------------------------
    @modal.method()
    def read_digits(self, crops: list, beams: int = 4, adapter: str = "A",
                    use_adapter: bool = True) -> list:
        """
        Read numeric cells (IDs, phones) rather than names.

        Separate from read() because the task differs in three ways: the prompt
        asks for digits, the name lexicon that read() uses to choose between the
        adapters is meaningless here, and the adapters were trained on names so
        running without them is worth measuring.

        Returns one dict per crop: {"text", "adapter", "use_adapter"}.
        """
        import time
        if not crops:
            return []
        t0 = time.time()
        images = [self._prepare(c) for c in crops]
        out = self._run(adapter, images, beams=beams,
                        prompt=DIGITS_PROMPT, use_adapter=use_adapter)
        print("[NameReader] read_digits {} crops in {:.1f}s (adapter={} on={})".format(
            len(crops), time.time() - t0, adapter, use_adapter))
        return [{"text": t, "adapter": adapter, "use_adapter": use_adapter}
                for t in out]

    @modal.method()
    def read(self, crops: list, beams: int = 4) -> list:
        """
        crops: PNG/JPEG bytes, one per name cell.

        Returns one dict per crop:
            name     the chosen reading
            a, b     each adapter's reading
            agree    both adapters produced the same name
            unknown  unknown-word count for the chosen name

        `agree` is the confidence signal: when the adapters agree the reading is
        usually right, and when they differ it usually needs a human.
        """
        import time

        if not crops:
            return []
        t0 = time.time()
        images = [self._prepare(c) for c in crops]

        a = self._run("A", images, beams=beams)
        b = self._run("B", images, beams=beams)

        results = []
        for ha, hb in zip(a, b):
            # Lexicon selection: prefer the candidate with fewer unknown words.
            # Ties go to A, the stronger adapter on its own.
            pick = hb if self._unknown(hb) < self._unknown(ha) else ha
            results.append({"name": pick, "a": ha, "b": hb,
                            "agree": ha == hb, "unknown": self._unknown(pick)})

        agreed = sum(1 for r in results if r["agree"])
        print("[NameReader] {} crops in {:.1f}s ({}/{} agreed)".format(
            len(crops), time.time() - t0, agreed, len(results)))
        return results

    @modal.method()
    def verify_batching(self, limit: int = 16) -> dict:
        """
        Prove batched reading matches one-at-a-time, and measure the speedup.

        Batching is only worth anything if the answers are unchanged; a wrong
        padding side would corrupt output silently rather than raise, so this
        compares the two paths crop for crop.
        """
        import time
        crops, _ = self._fetch(limit, frozen=True)
        images = [self._prepare(c) for c in crops]

        t0 = time.time()
        seq = self._run("A", images, batch=1)
        t_seq = time.time() - t0

        t0 = time.time()
        bat = self._run("A", images, batch=8)
        t_bat = time.time() - t0

        same = [s == b for s, b in zip(seq, bat)]
        diffs = [{"seq": s, "batched": b}
                 for s, b, ok in zip(seq, bat, same) if not ok]
        return {"n": len(images), "identical": sum(same),
                "seconds_sequential": round(t_seq, 1),
                "seconds_batched": round(t_bat, 1),
                "speedup": round(t_seq / max(t_bat, 0.01), 2),
                "diffs": diffs}

    @modal.method()
    def evaluate(self, limit: int = 10, frozen: bool = True, beams: int = 4) -> dict:
        """
        Score the reader against human labels.

        frozen=True uses the pinned test set the adapters were never trained on
        -- the only honest measurement. Scoring against recent approved crops
        instead reports memorisation.

        Crops are fetched here, inside the container, on Modal's network.
        Pulling them down to a laptop first is what made the original pipeline
        take 45 minutes a file, and it makes this untestable on a slow link.
        """
        crop_list, labels = self._fetch(limit, frozen)

        out = self.read.local(crop_list, beams=beams)

        # Score the truth through the SAME normaliser the predictions went
        # through. Folding only ة and ى marks correct readings wrong wherever
        # the label spells a hamza-alef (أ إ آ) that the model folded to ا.
        for truth, r in zip(labels, out):
            r["truth"] = truth
            r["hit"] = r["name"] == self.normalize(truth)
            # per-name credit, which is what an operator actually edits
            tw, pw = self.normalize(truth).split(), r["name"].split()
            r["words"] = len(tw)
            r["words_ok"] = sum(1 for a, b in zip(tw, pw) if a == b)
        res = {"n": len(out),
               "exact":     sum(1 for r in out if r["hit"]),
               "agreed":    sum(1 for r in out if r["agree"]),
               "words":     sum(r["words"] for r in out),
               "words_ok":  sum(r["words_ok"] for r in out),
               "rows": out}

        # Persist to the volume before returning. The caller is on a link that
        # drops, and a dropped client should not throw away GPU minutes -- the
        # result can be fetched later with:
        #   modal volume get arabic-htr-adapters eval_latest.json .
        try:
            import pathlib
            pathlib.Path("/adapters/eval_latest.json").write_text(
                json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            adapters.commit()
            print("[NameReader] result written to eval_latest.json")
        except Exception as e:
            print("[NameReader] could not persist result: " + str(e))
        return res


@app.local_entrypoint()
def batchcheck(limit: int = 16):
    """modal run execution/modal_lora_names.py::batchcheck"""
    r = NameReader().verify_batching.remote(limit)
    print()
    print("  identical answers  {}/{}".format(r["identical"], r["n"]))
    print("  one at a time      {}s".format(r["seconds_sequential"]))
    print("  batched            {}s".format(r["seconds_batched"]))
    print("  speedup            {}x".format(r["speedup"]))
    for d in r["diffs"]:
        print("    MISMATCH seq={!r} batched={!r}".format(d["seq"], d["batched"]))


@app.local_entrypoint()
def smoke(limit: int = 60, frozen: bool = True):
    """
    modal run --detach execution/modal_lora_names.py --limit 60

    --detach plus the volume write means a dropped connection loses nothing;
    collect the result later with
        modal volume get arabic-htr-adapters eval_latest.json .
    """
    res = NameReader().evaluate.remote(limit, frozen)
    rows, n = res["rows"], max(res["n"], 1)

    print()
    for r in rows:
        if not r["hit"]:
            print("  MISS  truth = " + str(r["truth"]))
            print("        read  = {}   ({}/{} names right)".format(
                r["name"], r["words_ok"], r["words"]))
            if not r["agree"]:
                print("        A = {}\n        B = {}".format(r["a"], r["b"]))

    ag  = [r for r in rows if r["agree"]]
    dis = [r for r in rows if not r["agree"]]
    edits = {}
    for r in rows:
        k = r["words"] - r["words_ok"]
        edits[k] = edits.get(k, 0) + 1

    print("\n  " + "=" * 50)
    print("  {} set, n = {}".format("HELD-OUT frozen" if frozen else "recent approved", n))
    print("  " + "=" * 50)
    print("  individual names   {}/{}  {:.1%}".format(
        res["words_ok"], res["words"], res["words_ok"] / max(res["words"], 1)))
    print("  full-name exact    {}/{}  {:.1%}".format(res["exact"], n, res["exact"] / n))
    print("  <=1 edit           {}/{}  {:.1%}".format(
        edits.get(0, 0) + edits.get(1, 0), n,
        (edits.get(0, 0) + edits.get(1, 0)) / n))
    print("\n  confidence signal")
    print("    agree  {:>3}/{:<3} -> {:.1%} right".format(
        sum(r["hit"] for r in ag), len(ag),
        sum(r["hit"] for r in ag) / max(len(ag), 1)))
    print("    differ {:>3}/{:<3} -> {:.1%} right".format(
        sum(r["hit"] for r in dis), len(dis),
        sum(r["hit"] for r in dis) / max(len(dis), 1)))
