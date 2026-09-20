"use client";

/**
 * InlineCropper — draggable crop box rendered directly on a training card.
 *
 * Replaces the previous modal-based "Adjust crop" workflow. The box is always
 * visible at a slight inset; trainer drags handles to tighten; 2 s after the
 * last drag we silently POST the cropped PNG to /recrop-cell. No save button,
 * no modal, no full reload — just the affected card's image refreshes.
 *
 * Performance:
 *   • Only the displayed <img> is fetched on render (browser standard path).
 *   • No blob fetch or canvas work until the user actually drags AND auto-save
 *     fires — so a grid of 30 cards loads at the same speed as before.
 *   • A lightweight in-component blob cache prevents the second auto-save from
 *     re-fetching the image bytes.
 */

import { useEffect, useRef, useState } from "react";

interface Props {
  cropId:  string;
  cropUrl: string | null;
  /** Wider CONTEXT image (cell + margin from the original page) the editor edits
   *  against. When provided, the editor displays this stable image and re-crops
   *  the tight region FROM it — so adjusting the box never zooms/shrinks the view
   *  and a cut-off word can be recovered by expanding into the margin. */
  contextUrl?: string | null;
  /** The tight crop's initial rectangle within the context image (context px). */
  contextBox?: { x: number; y: number; w: number; h: number } | null;
  /** Called after a successful auto-save so the parent can bust its image cache. */
  onSaved?: () => void;
  /** Disabled state — used when admin has already approved (read-only). */
  disabled?: boolean;
}

type Box = { x: number; y: number; w: number; h: number };

const INSET_PCT  = 0.08;     // default box is inset 8% so it reads as an adjustable
                             // bounding box centred on the name; trainer drags to fit.
const HANDLE     = 14;       // visible handle size (px) — bigger so fingers can see it
const HIT_PAD    = 14;       // invisible hit-area padding around each handle (touch-friendly)
const MIN_SZ     = 16;       // minimum crop dimension (image pixels)
const SAVE_IDLE  = 1000;     // ms idle before auto-save

export function InlineCropper({ cropId, cropUrl, contextUrl, contextBox, onSaved, disabled = false }: Props) {
  // The editor sources from the context image when available (stable, wider),
  // otherwise falls back to the tight crop (legacy rows without a context).
  const srcUrl = contextUrl ?? cropUrl;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef  = useRef<HTMLImageElement | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox]         = useState<Box | null>(null);
  const [dirty, setDirty]     = useState(false);
  const [saving, setSaving]   = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr]         = useState<string | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag state — kept in a ref so handlers don't recreate.
  const dragRef = useRef<{ kind: string; startX: number; startY: number; startBox: Box } | null>(null);

  function pickPointer(ev: React.PointerEvent, kind: string) {
    if (!box || disabled) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragRef.current = { kind, startX: ev.clientX, startY: ev.clientY, startBox: { ...box } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }
  function onMove(ev: PointerEvent) {
    if (!dragRef.current || !imgSize || !wrapRef.current) return;
    const { kind, startX, startY, startBox } = dragRef.current;
    const rect   = wrapRef.current.getBoundingClientRect();
    const scaleX = imgSize.w / rect.width;
    const scaleY = imgSize.h / rect.height;
    const dx = (ev.clientX - startX) * scaleX;
    const dy = (ev.clientY - startY) * scaleY;
    let { x, y, w, h } = startBox;
    if (kind === "move") {
      x = clamp(x + dx, 0, imgSize.w - w);
      y = clamp(y + dy, 0, imgSize.h - h);
    } else {
      if (kind.includes("n")) { const ny = clamp(y + dy, 0, y + h - MIN_SZ); h += y - ny; y = ny; }
      if (kind.includes("s")) {                        h = clamp(h + dy, MIN_SZ, imgSize.h - y); }
      if (kind.includes("w")) { const nx = clamp(x + dx, 0, x + w - MIN_SZ); w += x - nx; x = nx; }
      if (kind.includes("e")) {                        w = clamp(w + dx, MIN_SZ, imgSize.w - x); }
    }
    setBox({ x: round(x), y: round(y), w: round(w), h: round(h) });
    setDirty(true);
  }
  function onUp() {
    dragRef.current = null;
    window.removeEventListener("pointermove", onMove);
  }

  function onImageLoad() {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setImgSize({ w, h });
    // Context mode: start the box at the tight crop's known rectangle within the
    // context image, so it reads as "this is the current crop; drag to adjust".
    // Fallback (no context): a centred inset box on the tight crop.
    if (contextBox) {
      const x = clamp(contextBox.x, 0, w - MIN_SZ);
      const y = clamp(contextBox.y, 0, h - MIN_SZ);
      setBox({ x, y, w: clamp(contextBox.w, MIN_SZ, w - x), h: clamp(contextBox.h, MIN_SZ, h - y) });
    } else {
      const ix = Math.round(w * INSET_PCT);
      const iy = Math.round(h * INSET_PCT);
      setBox({ x: ix, y: iy, w: w - 2 * ix, h: h - 2 * iy });
    }
    setDirty(false);
  }

  // Restore the box to the full image extent. Marks dirty so the full crop is
  // re-saved (useful when a previous tighten cut too much within this session).
  function resetBox(e: React.PointerEvent | React.MouseEvent) {
    e.stopPropagation();
    if (!imgSize || disabled) return;
    // Context mode: revert to the auto-detected tight crop. Fallback: full image.
    if (contextBox) {
      const x = clamp(contextBox.x, 0, imgSize.w - MIN_SZ);
      const y = clamp(contextBox.y, 0, imgSize.h - MIN_SZ);
      setBox({ x, y, w: clamp(contextBox.w, MIN_SZ, imgSize.w - x), h: clamp(contextBox.h, MIN_SZ, imgSize.h - y) });
    } else {
      setBox({ x: 0, y: 0, w: imgSize.w, h: imgSize.h });
    }
    setDirty(true);
  }

  // Auto-save when dirty + idle.
  useEffect(() => {
    if (!dirty || disabled) return;
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => { void doSave(); }, SAVE_IDLE);
    return () => { if (idleRef.current) clearTimeout(idleRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, dirty, disabled]);

  async function doSave() {
    if (!box || !imgSize || !srcUrl) return;
    setSaving(true);
    setErr(null);
    try {
      // Crop from the STABLE source (context when available), never from the
      // previously-saved tight crop — this is what makes editing non-destructive.
      const blob   = await (await fetch(srcUrl)).blob();
      const objUrl = URL.createObjectURL(blob);
      const img    = new Image();
      await new Promise<void>((res, rej) => {
        img.onload  = () => res();
        img.onerror = () => rej(new Error("Image decode failed"));
        img.src = objUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width  = box.w;
      canvas.height = box.h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No 2D context");
      ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      const dataUrl = canvas.toDataURL("image/png");
      URL.revokeObjectURL(objUrl);

      const res  = await fetch("/api/admin/training/recrop-cell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // In context mode, persist the box (context pixels) so the next viewer
        // (the reviewing admin) sees the crop this editor made.
        body: JSON.stringify({
          id: cropId,
          image_base64: dataUrl,
          ...(contextUrl ? { box: { x: box.x, y: box.y, w: box.w, h: box.h } } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDirty(false);
      setSavedAt(Date.now());
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Box as PERCENTAGES of the natural image size. Because the <img> below is
  // width:100% / height:auto (no letterboxing), these map exactly onto the
  // displayed image at any screen size — including mobile — with no need to
  // measure the container during render (which was unreliable on phones and
  // was why the crop box failed to appear there).
  const pctBox = box && imgSize
    ? {
        left:   (box.x / imgSize.w) * 100,
        top:    (box.y / imgSize.h) * 100,
        width:  (box.w / imgSize.w) * 100,
        height: (box.h / imgSize.h) * 100,
      }
    : null;

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative", width: "100%",
        background: "#f1f5f9",
        userSelect: "none", touchAction: "none",
        lineHeight: 0,
      }}
    >
      {srcUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          ref={imgRef}
          src={srcUrl}
          alt="crop"
          draggable={false}
          onLoad={onImageLoad}
          style={{ width: "100%", height: "auto", display: "block" }}
        />
      ) : (
        <span className="text-[10px] text-slate-400 py-8">image unavailable</span>
      )}

      {/* Crop box — positioned in % of the image so it works on every screen */}
      {pctBox && !disabled && (
        <div
          onPointerDown={(e) => pickPointer(e, "move")}
          style={{
            position: "absolute",
            left: `${pctBox.left}%`, top: `${pctBox.top}%`,
            width: `${pctBox.width}%`, height: `${pctBox.height}%`,
            border: "2px solid #6366f1",
            background: "rgba(99,102,241,0.04)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.85)",
            boxSizing: "border-box",
            cursor: "move", touchAction: "none",
          }}
        >
          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((kind) => {
            const cursorMap: Record<string, string> = {
              nw: "nwse-resize", se: "nwse-resize",
              ne: "nesw-resize", sw: "nesw-resize",
              n: "ns-resize",  s: "ns-resize",
              e: "ew-resize",  w: "ew-resize",
            };
            // Outer wrapper is the touch hit zone (transparent, padded).
            // Inner square is the visible indigo handle.
            const total = HANDLE + HIT_PAD * 2;
            const half  = total / 2;
            const wrap: React.CSSProperties = {
              position: "absolute",
              width:  total, height: total,
              padding: HIT_PAD, boxSizing: "border-box",
              cursor: cursorMap[kind],
              touchAction: "none",
              // No background — completely invisible hit zone.
            };
            if (kind.includes("n")) wrap.top    = -half;
            if (kind.includes("s")) wrap.bottom = -half;
            if (kind.includes("w")) wrap.left   = -half;
            if (kind.includes("e")) wrap.right  = -half;
            if (kind === "n" || kind === "s") wrap.left = `calc(50% - ${half}px)`;
            if (kind === "e" || kind === "w") wrap.top  = `calc(50% - ${half}px)`;

            const visible: React.CSSProperties = {
              width: HANDLE, height: HANDLE,
              background: "#6366f1",
              border: "2px solid #fff",
              borderRadius: kind.length === 2 ? 3 : 2,
              boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
              pointerEvents: "none",
            };
            return (
              <div
                key={kind}
                onPointerDown={(e) => { e.stopPropagation(); pickPointer(e, kind); }}
                style={wrap}
              >
                <div style={visible} />
              </div>
            );
          })}
        </div>
      )}

      {/* Save status indicator (top-left corner) */}
      <div style={{
        position: "absolute", top: 4, left: 4,
        fontSize: 9, padding: "2px 6px", borderRadius: 6,
        background: "rgba(15,23,42,0.7)", color: "#fff",
        opacity: saving || dirty || (savedAt && Date.now() - savedAt < 2000) || err ? 1 : 0,
        pointerEvents: "none",
        transition: "opacity 0.18s",
      }}>
        {saving ? "Saving…"
          : err   ? `Error`
          : dirty ? "Editing…"
          : "Saved ✓"}
      </div>

      {/* Reset button (top-right corner) */}
      {srcUrl && !disabled && (
        <button
          type="button"
          onClick={resetBox}
          title={contextBox ? "Reset to the auto-detected crop" : "Reset the box to the full image"}
          style={{
            position: "absolute", top: 4, right: 4,
            fontSize: 9, padding: "3px 7px", borderRadius: 6,
            background: "rgba(15,23,42,0.55)", color: "#fff",
            border: "none", cursor: "pointer", touchAction: "manipulation",
          }}
        >
          Reset
        </button>
      )}

      {/* One-line usage hint (bottom centre) — fades out once the user edits */}
      {srcUrl && !disabled && !dirty && (
        <div style={{
          position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)",
          fontSize: 9, padding: "2px 8px", borderRadius: 6,
          background: "rgba(15,23,42,0.55)", color: "#fff",
          pointerEvents: "none", whiteSpace: "nowrap",
        }}>
          Drag to fit the name · auto-saves
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }
function round(v: number)                          { return Math.round(v); }
