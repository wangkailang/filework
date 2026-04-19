interface PdfViewerProps {
  filePath: string;
}

export const PdfViewer = ({ filePath }: PdfViewerProps) => {
  const src = `local-file://open?path=${encodeURIComponent(filePath)}`;

  return (
    <iframe src={src} title="PDF Preview" className="w-full h-full border-0" />
  );
};
