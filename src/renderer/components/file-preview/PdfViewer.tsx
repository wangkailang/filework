import { localFileUrl } from "../../lib/local-file-url";

interface PdfViewerProps {
  filePath: string;
}

export const PdfViewer = ({ filePath }: PdfViewerProps) => {
  const src = localFileUrl(filePath);

  return (
    <iframe src={src} title="PDF Preview" className="w-full h-full border-0" />
  );
};
