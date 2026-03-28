'use client';

import { useCallback, useState } from 'react';

interface UploadAreaProps {
  onUploadComplete: () => void;
}

export default function UploadArea({ onUploadComplete }: UploadAreaProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter(
      (file) => file.type === 'application/pdf'
    );

    if (files.length === 0) {
      setError('Please drop PDF files only');
      return;
    }

    await uploadFiles(files);
  }, []);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(
      (file) => file.type === 'application/pdf'
    );

    if (files.length === 0) {
      setError('Please select PDF files only');
      return;
    }

    await uploadFiles(files);
  }, []);

  const uploadFiles = async (files: File[]) => {
    setIsUploading(true);
    setError(null);
    setUploadProgress(`Uploading ${files.length} file(s)...`);

    try {
      const formData = new FormData();
      files.forEach((file) => {
        formData.append('files', file);
      });

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Upload failed');
      }

      const result = await response.json();

      // Build progress message
      let message = `Processed ${result.processed} of ${result.total} invoice(s)`;
      if (result.skipped > 0) {
        message += ` (${result.skipped} skipped as duplicates)`;
      }
      setUploadProgress(message);

      // Refresh the invoice list
      setTimeout(() => {
        onUploadComplete();
        setUploadProgress(null);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setUploadProgress(null);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="mb-6">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          relative rounded-lg border-2 border-dashed p-8 text-center transition-colors
          ${isDragging
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 bg-white hover:border-gray-400'
          }
          ${isUploading ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
        `}
      >
        <input
          type="file"
          accept=".pdf"
          multiple
          onChange={handleFileSelect}
          className="absolute inset-0 cursor-pointer opacity-0"
          disabled={isUploading}
        />

        <div className="flex flex-col items-center">
          <svg
            className={`h-12 w-12 ${isDragging ? 'text-blue-500' : 'text-gray-400'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>

          <p className="mt-4 text-lg font-medium text-gray-700">
            {isUploading ? 'Processing...' : 'Drop PDF invoices here'}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            or click to browse files
          </p>
        </div>
      </div>

      {/* Progress message */}
      {uploadProgress && (
        <div className="mt-3 rounded-lg bg-blue-50 p-3">
          <p className="text-sm text-blue-700">{uploadProgress}</p>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="mt-3 rounded-lg bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => setError(null)}
            className="ml-2 text-red-700 hover:text-red-900"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
