export const JOB_STATUSES = {
  pending: { label: "قيد الانتظار", color: "bg-gray-100 text-gray-700" },
  processing: { label: "جارٍ المعالجة", color: "bg-blue-100 text-blue-700" },
  completed: { label: "مكتمل", color: "bg-green-100 text-green-700" },
  failed: { label: "فشل", color: "bg-red-100 text-red-700" },
} as const;

export const ACCEPTED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
];

export const MAX_FILE_SIZE_MB = 20;
