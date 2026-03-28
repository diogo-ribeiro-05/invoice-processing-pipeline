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
  const [errorDetails, setErrorDetails] = useState<string[]>([]);
  const [progressPercent, setProgressPercent] = useState(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);

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
    setErrorDetails([]);
    setUploadProgress(`Preparing ${files.length} file(s)...`);
    setProgressPercent(5);
    setCurrentFile(null);

    try {
      const formData = new FormData();
      files.forEach((file) => {
        formData.append('files', file);
      });

      setUploadProgress(`Uploading ${files.length} file(s)...`);
      setProgressPercent(10);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Upload failed: ${response.status}`);
      }

      // Check if response is streaming (SSE) or JSON
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        // Streaming response - read progress
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
          throw new Error('No response body');
        }

        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete messages
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const jsonStr = line.slice(6);
                const update = JSON.parse(jsonStr);

                if (update.type === 'progress') {
                  setProgressPercent(Math.round((update.current / update.total) * 100));
                  setCurrentFile(update.fileName || null);
                  setUploadProgress(update.message || `Processing ${update.current}/${update.total}...`);
                } else if (update.type === 'complete') {
                  setProgressPercent(100);
                  setCurrentFile(null);
                  setUploadProgress(update.message || 'Complete!');

                  if (update.summary) {
                    if (update.errors && update.errors.length > 0) {
                      setErrorDetails(update.errors);
                    }
                  }
                } else if (update.type === 'status') {
                  setUploadProgress(update.message);
                } else if (update.type === 'error') {
                  setError(update.message);
                }
              } catch (e) {
                console.error('Failed to parse progress update:', line, e);
              }
            }
          }
        }
      } else {
        // JSON response (fallback)
        const result = await response.json();

        let message = `Complete! ${result.processed} processed`;
        if (result.skipped > 0) {
          message += `, (${result.skipped} skipped as duplicates)`;
        }
        if (result.failed > 0) {
          message += `, (${result.failed} failed)`;
        }
        setUploadProgress(message);
        setProgressPercent(100);

        if (result.errors?.length > 0 || result.skippedFiles?.length > 0) {
          setErrorDetails([...(result.errors || []), ...(result.skippedFiles || [])]);
        }
      }

      // Refresh the invoice list
      setTimeout(() => {
        onUploadComplete();
        setUploadProgress(null);
        setProgressPercent(0);
        setErrorDetails([]);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setUploadProgress(null);
      setProgressPercent(0);
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

      {/* Animated Progress Bar */}
      {uploadProgress && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-blue-700">
              {uploadProgress}
            </span>
            {currentFile && (
              <span className="text-xs text-blue-600">
                {currentFile}
              </span>
            )}
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-blue-200">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                progressPercent === 100 ? 'bg-green-500' : 'bg-blue-600'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Error/Warning details */}
      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="flex items-start justify-between">
            <span className="text-sm font-medium text-red-700">
              {error}
            </span>
            <button
              onClick={() => {
                setError(null);
                setErrorDetails([]);
              }}
              className="text-red-700 hover:text-red-900"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Detailed error/skipped list */}
      {errorDetails.length > 0 && (
        <div className="mt-2 space-y-1">
          {errorDetails.map((detail, index) => (
            <p key={index} className="text-sm text-amber-600">
              {detail}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
