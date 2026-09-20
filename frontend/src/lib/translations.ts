import type { Lang } from "./lang-context";

type Bitext = Record<Lang, string>;
const tx = (en: string, ar: string): Bitext => ({ en, ar });

export const T = {
  // ── Status labels ───────────────────────────────────────────────────────
  status: {
    completed:  tx("Completed",   "مكتمل"),
    processing: tx("Processing",  "جارٍ المعالجة"),
    pending:    tx("Pending",     "في الانتظار"),
    failed:     tx("Failed",      "فشل"),
  },

  // ── Plan names ──────────────────────────────────────────────────────────
  plans: {
    free:     tx("Free",     "مجاني"),
    starter:  tx("Starter",  "أساسي"),
    standard: tx("Standard", "قياسي"),
    pro:      tx("Pro",      "احترافي"),
  },

  // ── Sidebar ─────────────────────────────────────────────────────────────
  nav: {
    dashboard: tx("Dashboard", "لوحة التحكم"),
    documents: tx("OCR Files", "ملفات OCR"),
    settings:  tx("Settings",  "الإعدادات"),
    billing:   tx("Billing",   "الفوترة"),
    support:   tx("Support",   "الدعم"),
    myAccount: tx("My Account","حسابي"),
  },

  // ── TopBar ──────────────────────────────────────────────────────────────
  topbar: {
    searchPlaceholder: tx("Search documents…",    "البحث في المستندات…"),
    signOut:           tx("Sign out",             "تسجيل الخروج"),
    settingsLink:      tx("Settings",             "الإعدادات"),
    noResults:         tx('No documents match',   'لا توجد نتائج لـ'),
    english:           tx("English",              "English"),
    arabic:            tx("العربية",              "العربية"),
  },

  // ── Dashboard ───────────────────────────────────────────────────────────
  dashboard: {
    title:          tx("Dashboard",            "لوحة التحكم"),
    uploadDoc:      tx("Upload Document",      "رفع مستند"),
    uploading:      tx("Uploading",            "جارٍ الرفع"),
    dragDrop:       tx("Drag & drop or click to browse — PDF, JPG, PNG",
                       "اسحب وأفلت أو انقر للاستعراض — PDF, JPG, PNG"),
    dropNow:        tx("Drop to upload",       "أفلت للرفع"),
    browse:         tx("Browse Files",         "استعراض الملفات"),
    encrypted:      tx("AES-256 encrypted",    "مشفّر بـ AES-256"),
    filesProcessed: tx("Files processed",      "الملفات المعالجة"),
    completed:      tx("Completed",            "مكتملة"),
    monthlyPages:   tx("Monthly pages",        "الصفحات الشهرية"),
    plan:           tx("plan",                 "خطة"),
    recentFiles:    tx("Recent Files",         "الملفات الأخيرة"),
    viewAll:        tx("View all",             "عرض الكل"),
    noFiles:        tx("No files yet — upload your first document above",
                       "لا توجد ملفات بعد — ارفع أول مستند أعلاه"),
    upgradeNow:     tx("Upgrade Plan",         "ترقية الخطة"),
    upgradeEarly:   tx("Upgrade Early",        "ترقية مبكراً"),
    participants:   tx("participants",         "مشارك"),
    cancel:         tx("Cancel",               "إلغاء"),
  },

  // ── Documents list ──────────────────────────────────────────────────────
  docList: {
    title:         tx("OCR Files",                "ملفات OCR"),
    subtitle:      tx("documents processed",      "مستندات معالجة"),
    uploadNew:     tx("Upload New",               "رفع جديد"),
    noFiles:       tx("No files yet",             "لا توجد ملفات بعد"),
    noFilesDesc:   tx("Upload your first document to get started",
                      "ارفع أول مستند للبدء"),
    uploadDoc:     tx("Upload Document",          "رفع مستند"),
    colDocument:   tx("Document",                 "المستند"),
    colDate:       tx("Date",                     "التاريخ"),
    colStatus:     tx("Status",                   "الحالة"),
    deleteConfirm: tx("Delete this document permanently?",
                      "هل تريد حذف هذا المستند نهائياً؟"),
  },

  // ── Document detail ─────────────────────────────────────────────────────
  docDetail: {
    backToDocuments:   tx("Back to documents",   "العودة للمستندات"),
    extractedDataset:  tx("Extracted",           "مستخرج"),
    datasetWord:       tx("Dataset",             "مجموعة البيانات"),
    participants:      tx("participants",        "مشارك"),
    processingInProgress: tx("Processing in progress…", "المعالجة جارية…"),
    analyzingDoc:      tx("Analyzing document — page will update automatically when complete",
                          "جارٍ تحليل المستند — سيتم تحديث الصفحة تلقائياً عند الاكتمال"),
    processingFailed:  tx("Processing failed",   "فشلت المعالجة"),
    failedNoMessage:   tx("An error occurred during processing. Please try reprocessing the document.",
                          "حدث خطأ أثناء المعالجة. يرجى إعادة المعالجة."),
    noParticipants:    tx("No participants extracted — make sure the document contains a clear registration table.",
                          "لم يتم استخراج مشاركين — تأكد من احتواء المستند على جدول تسجيل واضح."),
    confidence:        tx("Confidence",          "الدقة"),
    avgOcrAccuracy:    tx("Average OCR accuracy","متوسط دقة OCR"),
    statusLabel:       tx("Status",              "الحالة"),
    high:              tx("High",                "عالية"),
    reprocess:         tx("Reprocess",           "إعادة المعالجة"),
    reprocessConfirm:  tx("Reprocess this document from scratch?",
                          "هل تريد إعادة معالجة المستند من الصفر؟"),
    exportExcel:       tx("Export Excel",        "تصدير Excel"),
    docNotFound:       tx("Document not found",  "المستند غير موجود"),
    ocrDashboard:      tx("OCR Dashboard",       "لوحة OCR"),
    loading:           tx("Loading document…",   "جارٍ تحميل المستند…"),
  },

  // ── Settings ────────────────────────────────────────────────────────────
  settings: {
    title:        tx("Settings",        "الإعدادات"),
    subtitle:     tx("Manage your account and preferences",
                     "إدارة حسابك وتفضيلاتك"),
    account:      tx("Account",         "الحساب"),
    preferences:  tx("Preferences",    "التفضيلات"),
    danger:       tx("Danger Zone",     "منطقة الخطر"),
    email:        tx("Email",           "البريد الإلكتروني"),
    plan:         tx("Plan",            "الخطة"),
    pages:        tx("Pages used",      "الصفحات المستخدمة"),
    provider:     tx("OCR Provider",    "مزود OCR"),
    exportFmt:    tx("Export format",   "تنسيق التصدير"),
    language:     tx("Interface Language","لغة الواجهة"),
    deleteAccount:tx("Delete account",  "حذف الحساب"),
    deleteDesc:   tx("Permanently delete your account and all data",
                     "حذف حسابك وجميع بياناتك بشكل دائم"),
    deleteBtn:    tx("Delete",          "حذف"),
  },

  // ── Billing ─────────────────────────────────────────────────────────────
  billing: {
    title:            tx("Billing & Subscription",   "الفوترة والاشتراك"),
    subtitle:         tx("Manage your plan and monthly usage",
                         "إدارة خطتك واستخدامك الشهري"),
    upgradeSubtitle:  tx("Choose how you'd like to upgrade your plan",
                         "اختر طريقة ترقية خطتك"),
    currentPlan:      tx("Current Plan",             "الخطة الحالية"),
    currentBtn:       tx("Current Plan",              "الخطة الحالية"),
    availablePlans:   tx("Available Plans",           "الخطط المتاحة"),
    contactDirect:    tx("Contact us directly to upgrade",
                         "تواصل معنا مباشرة للترقية"),
    joinWaitlist:     tx("Join the waitlist",         "الانضمام لقائمة الانتظار"),
    joinWaitlistDesc: tx("We'll notify you as soon as self-service upgrade is ready",
                         "سنعلمك فور تفعيل الترقية الذاتية"),
    upgradePlan:      tx("Upgrade Plan",              "ترقية الخطة"),
    upgradeNow:       tx("Upgrade Now",               "الترقية الآن"),
    freeForever:      tx("Free forever",              "مجاني للأبد"),
    perMonth:         tx("/ month",                   "/ شهر"),
    notAvailable:     tx("Not available",             "غير متاح"),
    bestValue:        tx("Best Value",                "أفضل قيمة"),
    pagesUsed:        tx("Pages used this month",     "الصفحات المستخدمة هذا الشهر"),
    quotaExceeded:    tx("You've reached your monthly limit. Upgrade to continue processing documents.",
                         "لقد وصلت إلى حد الصفحات الشهري. قم بالترقية لمواصلة معالجة المستندات."),
    nearLimit:        tx("You're close to your monthly limit. Consider upgrading soon.",
                         "أنت قريب من حد الصفحات الشهري. فكر في الترقية قريباً."),
    paymentNotice:    tx("Online payment coming soon", "الدفع الإلكتروني قيد الإعداد"),
    paymentDesc:      tx("The payment gateway will be activated soon. In the meantime, you can join the waitlist or contact us directly to upgrade.",
                         "سيتم تفعيل بوابة الدفع قريباً. في غضون ذلك يمكنك الانضمام لقائمة الانتظار أو التواصل معنا مباشرة للترقية."),
  },

  // ── Common ──────────────────────────────────────────────────────────────
  common: {
    loading:   tx("Loading…",  "جارٍ التحميل…"),
    error:     tx("Error",     "خطأ"),
    cancel:    tx("Cancel",    "إلغاء"),
    save:      tx("Save",      "حفظ"),
    uploading: tx("Uploading…","جارٍ الرفع…"),
  },
};
