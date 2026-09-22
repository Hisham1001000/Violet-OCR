"use client";

import Link from "next/link";
import { useLang } from "@/lib/lang-context";

type Bi      = { en: string; ar: string };
type ListBi  = { en: string[]; ar: string[] };
type Section = { id: string; title: Bi; intro?: Bi; body?: Bi; list?: ListBi };
type Doc     = { id: string; label: Bi; intro: Bi; sections: Section[] };

const PAGE = {
  title:       { en: "Terms of Service & Privacy Policy", ar: "شروط الخدمة وسياسة الخصوصية" },
  subtitle:    { en: "How Violet works, and how we handle your documents and data", ar: "كيف تعمل Violet، وكيف نتعامل مع مستنداتك وبياناتك" },
  lastUpdated: { en: "Last updated: June 2026", ar: "آخر تحديث: يونيو 2026" },
  back:        { en: "← Back", ar: "→ رجوع" },
  toc:         { en: "Contents", ar: "المحتويات" },
  contact:     { en: "Contact", ar: "التواصل" },
  contactBody: { en: "Questions, concerns, or requests related to these Terms or this Policy — including data access, correction, or deletion requests — can be sent to:", ar: "يمكن إرسال الأسئلة أو المخاوف أو الطلبات المتعلقة بهذه الشروط أو هذه السياسة — بما في ذلك طلبات الوصول إلى البيانات أو تصحيحها أو حذفها — إلى:" },
};

const CONTACT_EMAIL = "violetocr4@gmail.com";

// ── Terms of Service ──────────────────────────────────────────────────────────
const TOS: Doc = {
  id: "terms",
  label: { en: "Terms of Service", ar: "شروط الخدمة" },
  intro: {
    en: "These Terms of Service (\"Terms\") govern your access to and use of Violet (the \"Service\"). By creating an account or uploading a document, you agree to be bound by these Terms and by the Privacy Policy below. If you do not agree, please do not use the Service.",
    ar: "تحكم شروط الخدمة هذه (\"الشروط\") وصولك إلى واستخدامك لـ Violet (\"الخدمة\"). بإنشائك حسابًا أو رفعك لمستند، فإنك توافق على الالتزام بهذه الشروط وبسياسة الخصوصية أدناه. إذا كنت لا توافق، يرجى عدم استخدام الخدمة.",
  },
  sections: [
    {
      id: "description",
      title: { en: "Description of Service", ar: "وصف الخدمة" },
      body: {
        en: "Violet is an AI-assisted OCR (Optical Character Recognition) platform that extracts structured tabular data from Arabic-language documents — such as attendance forms, registers, and participant lists — and converts it into editable, exportable spreadsheets. Extraction results are produced by automated systems and may contain errors. You are responsible for reviewing and correcting extracted data before relying on it for any official, financial, medical, or legal purpose.",
        ar: "Violet هي منصة استخراج نصوص بالذكاء الاصطناعي (OCR) تستخرج البيانات الجدولية المنظمة من المستندات باللغة العربية — مثل نماذج الحضور والسجلات وقوائم المشاركين — وتحوّلها إلى جداول قابلة للتعديل والتصدير. نتائج الاستخراج تُنتج بواسطة أنظمة آلية وقد تحتوي على أخطاء. أنت المسؤول عن مراجعة وتصحيح البيانات المستخرجة قبل الاعتماد عليها في أي غرض رسمي أو مالي أو طبي أو قانوني.",
      },
    },
    {
      id: "acceptable-use",
      title: { en: "Acceptable Use", ar: "الاستخدام المقبول" },
      intro: { en: "By using Violet, you agree that you will:", ar: "باستخدامك لـ Violet، فإنك توافق على أنك:" },
      list: {
        en: [
          "Only upload documents you own, or that you have explicit authorization to process.",
          "Not upload unlawful, infringing, harmful, or malicious content.",
          "Not attempt to reverse-engineer, scrape, probe, or disrupt the Service or its infrastructure.",
          "Not access the Service through automated means beyond normal interactive use, except through an API we explicitly provide for that purpose.",
          "Not upload highly sensitive personal data (e.g. government identity documents, medical records, full financial account numbers) unless you have independently confirmed this is lawful and you accept full responsibility for that data.",
          "Comply with all data protection and privacy laws applicable to any personal data contained in documents you upload — including obtaining any consents required from the individuals named in those documents — and with GDPR where it applies to you.",
        ],
        ar: [
          "ترفع فقط المستندات التي تملكها، أو التي لديك إذن صريح لمعالجتها.",
          "لا ترفع محتوى غير قانوني أو منتهك للحقوق أو ضار أو خبيث.",
          "لا تحاول الهندسة العكسية أو سحب البيانات أو فحص أو تعطيل الخدمة أو بنيتها التحتية.",
          "لا تصل إلى الخدمة بوسائل آلية تتجاوز الاستخدام التفاعلي العادي، إلا عبر واجهة برمجية (API) نوفرها صريحًا لهذا الغرض.",
          "لا ترفع بيانات شخصية بالغة الحساسية (مثل وثائق الهوية الحكومية أو السجلات الطبية أو أرقام الحسابات المالية الكاملة) إلا إذا تأكدت بشكل مستقل من قانونية ذلك وقبلت المسؤولية الكاملة عن تلك البيانات.",
          "تمتثل لجميع قوانين حماية البيانات والخصوصية المعمول بها على أي بيانات شخصية واردة في المستندات التي ترفعها — بما في ذلك الحصول على أي موافقات مطلوبة من الأفراد المذكورين في تلك المستندات — وللائحة GDPR حيثما تنطبق عليك.",
        ],
      },
    },
    {
      id: "account",
      title: { en: "Account Registration & Security", ar: "تسجيل الحساب وأمانه" },
      body: {
        en: "You must provide accurate information when creating an account and are responsible for keeping your login credentials confidential. You are responsible for all activity that occurs under your account. Notify us immediately at the contact address below if you suspect unauthorized access.",
        ar: "يجب عليك تقديم معلومات دقيقة عند إنشاء حساب، وأنت مسؤول عن الحفاظ على سرية بيانات تسجيل الدخول الخاصة بك. أنت مسؤول عن جميع الأنشطة التي تتم عبر حسابك. يرجى إخبارنا فورًا على عنوان التواصل أدناه إذا اشتبهت بوصول غير مصرح به.",
      },
    },
    {
      id: "plans",
      title: { en: "Billing", ar: "الفوترة" },
      body: {
        en: "Violet is prepaid and charged for what it extracts: you add credit, and every processing run deducts 1.5 cents for each row it extracts, rounded up to a whole cent once per run. There are no subscription plans, no monthly quota, no per-upload page limit and no recurring charge. Credit does not expire. A run that extracts no rows costs nothing; a run that costs more than your balance is completed and held until you add credit. We reserve the right to suspend or rate-limit accounts that exceed reasonable use.",
        ar: "Violet مدفوعة مسبقاً وتُحتسب على ما تستخرجه: تضيف رصيداً، ويُخصم في كل معالجة سنت ونصف عن كل صف تستخرجه، مع التقريب إلى سنت كامل مرة واحدة لكل معالجة. لا توجد خطط اشتراك ولا حصة شهرية ولا حد لعدد الصفحات في كل عملية رفع ولا رسوم متكررة. الرصيد لا ينتهي. المعالجة التي لا تستخرج صفوفاً لا تكلّف شيئاً، وإذا تجاوزت تكلفة المعالجة رصيدك تكتمل المعالجة وتُحتجَز النتيجة حتى تضيف رصيداً. ونحتفظ بالحق في تعليق أو تقييد الحسابات التي تتجاوز الاستخدام المعقول.",
      },
    },
    {
      id: "ownership",
      title: { en: "Intellectual Property & Ownership of Your Data", ar: "الملكية الفكرية وملكية بياناتك" },
      body: {
        en: "As between you and Violet, you retain all ownership rights in the documents you upload and in the data extracted from them. We claim no ownership over your content. You grant us a limited license to process, store, and display your documents and extracted data solely to provide and improve the Service, as described in the Privacy Policy below. The Violet name, branding, and underlying software are owned by us and may not be copied, reproduced, or used without our permission.",
        ar: "فيما بينك وبين Violet، تحتفظ بجميع حقوق الملكية للمستندات التي ترفعها والبيانات المستخرجة منها. لا نطالب بأي ملكية على محتواك. تمنحنا ترخيصًا محدودًا لمعالجة وتخزين وعرض مستنداتك وبياناتك المستخرجة فقط لتقديم وتحسين الخدمة، كما هو موضح في سياسة الخصوصية أدناه. اسم Violet وعلامتها التجارية والبرمجيات الأساسية مملوكة لنا ولا يجوز نسخها أو إعادة إنتاجها أو استخدامها دون إذننا.",
      },
    },
    {
      id: "availability",
      title: { en: "Service Availability & Disclaimer", ar: "توفر الخدمة وإخلاء المسؤولية" },
      body: {
        en: "Violet is provided on an \"as is\" and \"as available\" basis. While we work to maintain high uptime, we do not guarantee uninterrupted or error-free service. OCR accuracy depends on document quality, handwriting legibility, and scan resolution, and is not guaranteed to be 100% correct — always review extracted data before relying on it.",
        ar: "تُقدَّم Violet \"كما هي\" و\"كما هي متوفرة\". وبينما نعمل على الحفاظ على وقت تشغيل مرتفع، فإننا لا نضمن خدمة دون انقطاع أو خالية من الأخطاء. تعتمد دقة OCR على جودة المستند ووضوح الكتابة اليدوية ودقة المسح، ولا يُضمن أن تكون صحيحة بنسبة 100٪ — راجع دائمًا البيانات المستخرجة قبل الاعتماد عليها.",
      },
    },
    {
      id: "liability",
      title: { en: "Limitation of Liability", ar: "حدود المسؤولية" },
      body: {
        en: "To the maximum extent permitted by law, Violet and its operators are not liable for any indirect, incidental, special, or consequential damages, or for any loss of data, revenue, or business opportunity, arising from your use of or inability to use the Service, including errors in OCR output. Our total liability for any claim relating to the Service is limited to the amount you paid us in the three months preceding the claim.",
        ar: "إلى أقصى حد يسمح به القانون، لا تتحمل Violet ومشغّلوها أي مسؤولية عن أضرار غير مباشرة أو عرضية أو خاصة أو تبعية، أو عن أي فقدان للبيانات أو الإيرادات أو فرص العمل، ناشئة عن استخدامك للخدمة أو عدم قدرتك على استخدامها، بما في ذلك أخطاء نتائج OCR. تقتصر مسؤوليتنا الإجمالية عن أي مطالبة متعلقة بالخدمة على المبلغ الذي دفعته لنا خلال الأشهر الثلاثة السابقة للمطالبة.",
      },
    },
    {
      id: "suspension",
      title: { en: "Suspension & Termination", ar: "التعليق والإنهاء" },
      body: {
        en: "We may suspend or terminate your account if you violate these Terms — including uploading prohibited content, abusing quotas, or engaging in fraudulent payment activity. Banned users will be notified by email and may appeal by contacting support. You may stop using the Service and delete your documents at any time. To request deletion of your account itself, contact us as described below; see the Privacy Policy for what happens to your data when your account is deleted.",
        ar: "يجوز لنا تعليق أو إنهاء حسابك في حال مخالفتك لهذه الشروط — بما في ذلك رفع محتوى محظور، أو إساءة استخدام الحصص، أو الانخراط في نشاط دفع احتيالي. سيتم إخطار المستخدمين المحظورين عبر البريد الإلكتروني ويمكنهم الاستئناف عبر التواصل مع الدعم. يمكنك التوقف عن استخدام الخدمة وحذف مستنداتك في أي وقت. لطلب حذف حسابك نفسه، تواصل معنا كما هو موضح أدناه؛ راجع سياسة الخصوصية لمعرفة ما يحدث لبياناتك عند حذف حسابك.",
      },
    },
    {
      id: "changes-terms",
      title: { en: "Changes to These Terms", ar: "التغييرات على هذه الشروط" },
      body: {
        en: "We may update these Terms from time to time. Material changes will be communicated by email or an in-app notice. Continued use of Violet after changes take effect constitutes acceptance of the updated Terms.",
        ar: "قد نقوم بتحديث هذه الشروط من وقت لآخر. سيتم إبلاغ التغييرات الجوهرية عبر البريد الإلكتروني أو عبر إشعار داخل التطبيق. يشكل استمرارك في استخدام Violet بعد سريان التغييرات قبولاً للشروط المحدثة.",
      },
    },
  ],
};

// ── Privacy Policy ─────────────────────────────────────────────────────────────
const PRIVACY: Doc = {
  id: "privacy",
  label: { en: "Privacy Policy", ar: "سياسة الخصوصية" },
  intro: {
    en: "This Privacy Policy explains what information Violet collects, how we use and store it — including the documents you upload — who can access it, and the choices available to you. It should be read together with the Terms of Service above.",
    ar: "تشرح سياسة الخصوصية هذه المعلومات التي تجمعها Violet، وكيف نستخدمها ونخزنها — بما في ذلك المستندات التي ترفعها — ومن يمكنه الوصول إليها، والخيارات المتاحة لك. يجب قراءتها مع شروط الخدمة أعلاه.",
  },
  sections: [
    {
      id: "info-we-collect",
      title: { en: "Information We Collect", ar: "المعلومات التي نجمعها" },
      list: {
        en: [
          "Account information: your email address and authentication identifiers, supplied when you sign up.",
          "Uploaded documents: the files you submit for OCR processing, and the text and structured data we extract from them.",
          "Your corrections: edits you make to extracted data in our editor.",
          "Usage information: your plan, page-processing counts, last active time, and login activity, used to enforce plan quotas and maintain your account.",
          "Support communications: messages you send us through the support form, WhatsApp, or email, and the contact details associated with them.",
        ],
        ar: [
          "معلومات الحساب: بريدك الإلكتروني ومعرّفات المصادقة، التي تقدمها عند التسجيل.",
          "المستندات المرفوعة: الملفات التي ترفعها لمعالجة OCR، والنصوص والبيانات المنظمة التي نستخرجها منها.",
          "تصحيحاتك: التعديلات التي تقوم بها على البيانات المستخرجة في محررنا.",
          "معلومات الاستخدام: خطتك، وعدد الصفحات المعالجة، وآخر وقت نشاط، ونشاط تسجيل الدخول، وتُستخدم لتطبيق حصص الخطة والحفاظ على حسابك.",
          "اتصالات الدعم: الرسائل التي ترسلها لنا عبر نموذج الدعم أو واتساب أو البريد الإلكتروني، وبيانات التواصل المرتبطة بها.",
        ],
      },
    },
    {
      id: "how-we-use",
      title: { en: "How We Use Your Information", ar: "كيف نستخدم معلوماتك" },
      list: {
        en: [
          "To provide the OCR and document-extraction service you request.",
          "To enforce plan quotas and manage your account.",
          "To improve OCR accuracy — through anonymized text-correction pairs and, where needed for quality review, cropped images of specific fields reviewed by authorized staff (see \"Training Data & Quality Improvement\" below).",
          "To respond to support requests.",
        ],
        ar: [
          "لتقديم خدمة OCR واستخراج المستندات التي تطلبها.",
          "لتطبيق حصص الخطة وإدارة حسابك.",
          "لتحسين دقة OCR — عبر أزواج نصية مصححة بشكل مجهّل، وعند الحاجة لمراجعة الجودة، عبر صور مقصوصة لحقول محددة يراجعها موظفون مخوّلون (انظر \"بيانات التدريب وتحسين الجودة\" أدناه).",
          "للرد على طلبات الدعم.",
        ],
      },
      body: {
        en: "We do not sell your personal information or your documents to any third party.",
        ar: "لا نبيع معلوماتك الشخصية أو مستنداتك لأي طرف ثالث.",
      },
    },
    {
      id: "subprocessors",
      title: { en: "How Your Documents Are Processed", ar: "كيف تُعالَج مستنداتك" },
      body: {
        en: "When you upload a document, Violet sends it to specialized AI/OCR providers to extract text and structure: Microsoft Azure Document Intelligence, Google Cloud Vision, and Google Gemini. These providers act as our processing partners solely to return extraction results to us, under their own API terms — they do not receive your account information, and we do not share your documents with them for any other purpose. We do not knowingly permit our AI providers to use your documents to train their general-purpose models; we will update this Policy if that arrangement changes.",
        ar: "عند رفعك لمستند، ترسله Violet إلى مزوّدي ذكاء اصطناعي وOCR متخصصين لاستخراج النص والبنية: Microsoft Azure Document Intelligence وGoogle Cloud Vision وGoogle Gemini. يعمل هؤلاء المزودون كشركاء معالجة لنا فقط لإعادة نتائج الاستخراج إلينا، بموجب شروط واجهاتهم البرمجية الخاصة — وهم لا يتلقون معلومات حسابك، ولا نشارك مستنداتك معهم لأي غرض آخر. لا نسمح عن علم لمزوّدي الذكاء الاصطناعي لدينا باستخدام مستنداتك لتدريب نماذجهم العامة، وسنحدّث هذه السياسة إذا تغيّر هذا الترتيب.",
      },
    },
    {
      id: "storage-security",
      title: { en: "Where Your Data Is Stored & Security Measures", ar: "أين تُخزَّن بياناتك وتدابير الأمان" },
      body: {
        en: "Uploaded files are stored in Supabase Storage; extracted text and structured data are stored in our Supabase database. Stored files are encrypted at rest by our storage provider, and all traffic between your browser and Violet is encrypted in transit (HTTPS/TLS). Access to your documents is restricted by database access policies tied to your account — by default, only you can view your own documents.",
        ar: "تُخزَّن الملفات المرفوعة في Supabase Storage، وتُخزَّن النصوص المستخرجة والبيانات المنظمة في قاعدة بياناتنا على Supabase. تُشفَّر الملفات المخزَّنة أثناء سكونها (encrypted at rest) من قِبل مزود التخزين، وتُشفَّر جميع البيانات المتبادلة بين متصفحك وViolet أثناء النقل (HTTPS/TLS). الوصول إلى مستنداتك مقيّد بسياسات وصول قاعدة بيانات مرتبطة بحسابك — وبشكل افتراضي، أنت فقط من يمكنه رؤية مستنداتك.",
      },
    },
    {
      id: "who-can-access",
      title: { en: "Who Can Access Your Documents", ar: "من يمكنه الوصول إلى مستنداتك" },
      body: {
        en: "Your documents and extracted data are visible to you by default. Authorized Violet administrators and trainers may access a specific document or extracted field only when necessary to: investigate a support request you submitted, review and improve OCR accuracy through our quality-review process, or apply a correction you have requested.",
        ar: "تكون مستنداتك وبياناتك المستخرجة مرئية لك بشكل افتراضي. يجوز لمسؤولي ومراجعي Violet المخوّلين الوصول إلى مستند معيّن أو حقل مستخرج فقط عند الحاجة إلى: التحقيق في طلب دعم قدّمته، أو مراجعة وتحسين دقة OCR من خلال عملية مراجعة الجودة لدينا، أو تطبيق تصحيح طلبته.",
      },
    },
    {
      id: "training-data",
      title: { en: "Training Data & Quality Improvement", ar: "بيانات التدريب وتحسين الجودة" },
      body: {
        en: "To improve OCR accuracy, Violet may retain: (a) anonymized pairs of original and corrected text, without surrounding document context, and (b) small cropped images of specific fields (for example, a name cell) taken from processed documents, used by authorized reviewers to verify and train the extraction models. These crops are not published, sold, or shared outside Violet. If you would prefer your documents are not used for this purpose, contact us using the details below.",
        ar: "لتحسين دقة OCR، قد تحتفظ Violet بـ: (أ) أزواج مجهّلة من النص الأصلي والنص المصحَّح، دون سياق المستند المحيط، و(ب) صور مقصوصة صغيرة لحقول محددة (مثل خلية اسم) مأخوذة من المستندات المعالَجة، يستخدمها مراجعون مخوّلون للتحقق من نماذج الاستخراج وتدريبها. لا تُنشر هذه الصور أو تُباع أو تُشارَك خارج Violet. إذا كنت تفضّل عدم استخدام مستنداتك لهذا الغرض، تواصل معنا عبر البيانات أدناه.",
      },
    },
    {
      id: "retention",
      title: { en: "Data Retention & Your Control Over It", ar: "الاحتفاظ بالبيانات وتحكّمك بها" },
      body: {
        en: "Your whole document history stays visible in your dashboard: there is no time window and nothing is hidden behind a plan. You can permanently delete any individual document yourself, at any time, from its detail page; this immediately removes the file from storage and its associated database records. We do not currently run an automated process that deletes documents purely based on age — documents remain stored until you delete them or your account is closed.",
        ar: "يبقى سجل مستنداتك كاملاً مرئيًا في لوحة التحكم: لا توجد نافذة زمنية ولا شيء محجوب خلف خطة. يمكنك حذف أي مستند فردي بشكل دائم بنفسك، في أي وقت، من صفحة تفاصيله؛ ويؤدي ذلك فورًا إلى إزالة الملف من التخزين وسجلاته المرتبطة في قاعدة البيانات. لا نُشغّل حاليًا عملية تلقائية تحذف المستندات بناءً على عمرها فقط — تبقى المستندات مخزَّنة إلى أن تحذفها أنت أو يتم إغلاق حسابك.",
      },
    },
    {
      id: "account-deletion",
      title: { en: "Account Deletion", ar: "حذف الحساب" },
      body: {
        en: "To request deletion of your account, contact us using the details in the Contact section. Upon request, we will permanently delete your account profile and your remaining documents. Anonymized training data described above (cropped field images and text-correction pairs no longer linked to your identity) may be retained to maintain OCR quality for the platform.",
        ar: "لطلب حذف حسابك، تواصل معنا عبر البيانات الواردة في قسم التواصل. عند الطلب، سنحذف بشكل دائم ملفك الشخصي ومستنداتك المتبقية. قد يتم الاحتفاظ ببيانات التدريب المجهّلة المذكورة أعلاه (صور الحقول المقصوصة وأزواج النص المصحَّح غير المرتبطة بهويتك) للحفاظ على جودة OCR للمنصة.",
      },
    },
    {
      id: "your-rights",
      title: { en: "Your Rights", ar: "حقوقك" },
      body: {
        en: "Depending on your jurisdiction, you may have rights to access, correct, export, or delete your personal data. You can correct extracted data directly in the editor, delete individual documents yourself at any time, and request account deletion as described above. For any other request regarding your data, contact us.",
        ar: "بحسب الولاية القضائية التي تخضع لها، قد يكون لديك حقوق في الوصول إلى بياناتك الشخصية أو تصحيحها أو تصديرها أو حذفها. يمكنك تصحيح البيانات المستخرجة مباشرة في المحرر، وحذف المستندات الفردية بنفسك في أي وقت، وطلب حذف الحساب كما هو موضح أعلاه. لأي طلب آخر يتعلق ببياناتك، تواصل معنا.",
      },
    },
    {
      id: "cookies",
      title: { en: "Cookies & Similar Technologies", ar: "ملفات تعريف الارتباط والتقنيات المشابهة" },
      body: {
        en: "Violet uses only the cookies necessary to keep you signed in, managed by our authentication provider (Supabase). We do not use third-party advertising or analytics cookies. We separately record basic account activity, such as your last active time, to maintain your session and enforce plan limits — this is not shared with third parties.",
        ar: "تستخدم Violet فقط ملفات تعريف الارتباط الضرورية لإبقائك مسجّل الدخول، وتُدار من خلال مزود المصادقة لدينا (Supabase). لا نستخدم ملفات تعريف ارتباط للإعلانات أو التحليلات من أطراف ثالثة. نسجّل بشكل منفصل نشاطًا أساسيًا للحساب، مثل آخر وقت نشاط، للحفاظ على جلستك وتطبيق حدود الخطة — ولا تتم مشاركة ذلك مع أطراف ثالثة.",
      },
    },
    {
      id: "international",
      title: { en: "International Use", ar: "الاستخدام الدولي" },
      body: {
        en: "Violet may process and store data on servers located in a different country than your own. By using the Service, you consent to this transfer. We take reasonable steps to protect your data regardless of where it is processed, consistent with this Policy.",
        ar: "قد تعالج Violet وتخزّن البيانات على خوادم تقع في بلد مختلف عن بلدك. باستخدامك للخدمة، فإنك توافق على هذا النقل. نتخذ خطوات معقولة لحماية بياناتك بغض النظر عن مكان معالجتها، بما يتوافق مع هذه السياسة.",
      },
    },
    {
      id: "children",
      title: { en: "Children's Privacy", ar: "خصوصية الأطفال" },
      body: {
        en: "Violet is not directed at children, and we do not knowingly collect personal data from individuals under 16. If you believe a child has provided us with personal data, contact us so we can remove it.",
        ar: "لا تستهدف Violet الأطفال، ولا نجمع عن علم بيانات شخصية من أفراد تقل أعمارهم عن 16 عامًا. إذا كنت تعتقد أن طفلاً قدّم لنا بيانات شخصية، تواصل معنا لإزالتها.",
      },
    },
    {
      id: "changes-privacy",
      title: { en: "Changes to This Policy", ar: "التغييرات على هذه السياسة" },
      body: {
        en: "We may update this Policy from time to time. Material changes will be communicated by email or an in-app notice. Continued use of Violet after changes take effect constitutes acceptance of the updated Policy.",
        ar: "قد نقوم بتحديث هذه السياسة من وقت لآخر. سيتم إبلاغ التغييرات الجوهرية عبر البريد الإلكتروني أو عبر إشعار داخل التطبيق. يشكل استمرارك في استخدام Violet بعد سريان التغييرات قبولاً للسياسة المحدثة.",
      },
    },
  ],
};

const DOCS: Doc[] = [TOS, PRIVACY];

export default function PolicyPage() {
  const { lang } = useLang();
  const isRtl = lang === "ar";
  const tt = (b: Bi) => b[lang];

  return (
    <div
      dir={isRtl ? "rtl" : "ltr"}
      style={{
        minHeight: "100vh",
        background: "#fafafa",
        padding: "48px 20px",
        fontFamily: "'Inter','Alexandria',sans-serif",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <Link
          href="/"
          style={{
            display: "inline-block",
            color: "#7c3aed",
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
            marginBottom: 28,
          }}
        >
          {tt(PAGE.back)}
        </Link>

        <header style={{ marginBottom: 36 }}>
          <h1 style={{ fontSize: 32, fontWeight: 800, color: "#0f172a", margin: "0 0 8px", letterSpacing: "-0.02em" }}>
            {tt(PAGE.title)}
          </h1>
          <p style={{ fontSize: 14, color: "#64748b", margin: "0 0 6px" }}>{tt(PAGE.subtitle)}</p>
          <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>{tt(PAGE.lastUpdated)}</p>
        </header>

        {/* Table of contents — jumps to either document */}
        <nav
          style={{
            background: "#fff",
            borderRadius: 16,
            padding: "20px 24px",
            marginBottom: 24,
            boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.04)",
          }}
        >
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#94a3b8", margin: "0 0 10px" }}>
            {tt(PAGE.toc)}
          </p>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            {DOCS.map((d) => (
              <a key={d.id} href={`#${d.id}`} style={{ fontSize: 13, fontWeight: 600, color: "#7c3aed", textDecoration: "none" }}>
                {tt(d.label)}
              </a>
            ))}
          </div>
        </nav>

        {DOCS.map((doc) => (
          <main
            key={doc.id}
            id={doc.id}
            style={{
              background: "#fff",
              borderRadius: 16,
              padding: "36px 32px",
              marginBottom: 24,
              boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.04)",
            }}
          >
            <h2 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", margin: "0 0 12px", letterSpacing: "-0.01em" }}>
              {tt(doc.label)}
            </h2>
            <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.75, margin: "0 0 28px" }}>
              {tt(doc.intro)}
            </p>

            {doc.sections.map((s, i) => (
              <section key={s.id} id={s.id} style={{ marginBottom: i === doc.sections.length - 1 ? 0 : 26 }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 10px" }}>
                  {i + 1}. {tt(s.title)}
                </h3>
                {s.intro && (
                  <p style={{ fontSize: 13, color: "#475569", lineHeight: 1.75, margin: "0 0 10px" }}>
                    {tt(s.intro)}
                  </p>
                )}
                {s.list && (
                  <ul style={{ margin: s.body ? "0 0 10px" : 0, paddingInlineStart: 22 }}>
                    {s.list[lang].map((item, idx) => (
                      <li key={idx} style={{ fontSize: 13, color: "#475569", lineHeight: 1.75, marginBottom: 6 }}>
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
                {s.body && (
                  <p style={{ fontSize: 13, color: "#475569", lineHeight: 1.75, margin: 0 }}>
                    {tt(s.body)}
                  </p>
                )}
              </section>
            ))}
          </main>
        ))}

        {/* Contact — shared by both documents */}
        <section
          style={{
            background: "#fff",
            borderRadius: 16,
            padding: "28px 32px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.04)",
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 10px" }}>
            {tt(PAGE.contact)}
          </h2>
          <p style={{ fontSize: 13, color: "#475569", lineHeight: 1.75, margin: "0 0 10px" }}>
            {tt(PAGE.contactBody)}
          </p>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              fontWeight: 600,
              color: "#7c3aed",
              textDecoration: "none",
            }}
          >
            {CONTACT_EMAIL}
          </a>
        </section>

        <footer style={{ textAlign: "center", marginTop: 32, fontSize: 11, color: "#94a3b8" }}>
          © {new Date().getFullYear()} Violet · All rights reserved
        </footer>
      </div>
    </div>
  );
}
