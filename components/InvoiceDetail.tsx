'use client';

import type { ProcessedInvoice, LineItem } from '@/lib/types';
import ValidationBadge from './ValidationBadge';

interface InvoiceDetailProps {
  invoice: ProcessedInvoice | null;
  onClose: () => void;
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(amount);
  } catch {
    return `${currency} ${amount?.toFixed(2) || '0.00'}`;
  }
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString();
  } catch {
    return dateStr;
  }
}

function getValidationStatus(notes: string): 'matched' | 'flagged' {
  const lowerNotes = notes?.toLowerCase() || '';
  if (lowerNotes.includes('fully validated') && !lowerNotes.includes('not found') && !lowerNotes.includes('missing') && !lowerNotes.includes('mismatch')) {
    return 'matched';
  }
  return 'flagged';
}

// Parse processing notes into individual messages
function parseProcessingNotes(notes: string): string[] {
  if (!notes) return [];
  // Split by semicolons, periods followed by space, or just periods at the end
  return notes
    .split(/[;.]/)
    .map(n => n.trim())
    .filter(n => n.length > 0);
}

// Determine note type for styling
function getNoteType(note: string): 'success' | 'warning' | 'info' {
  const lowerNote = note.toLowerCase();

  // Positive/success indicators
  if (lowerNote.includes('matched') && !lowerNote.includes('not matched') && !lowerNote.includes('mismatch')) {
    return 'success';
  }
  if (lowerNote.includes('found') && !lowerNote.includes('not found')) {
    return 'success';
  }
  if (lowerNote.includes('success')) {
    return 'success';
  }
  if (lowerNote.includes('fully validated')) {
    return 'success';
  }

  // Negative/warning indicators
  if (lowerNote.includes('not found')) {
    return 'warning';
  }
  if (lowerNote.includes('missing')) {
    return 'warning';
  }
  if (lowerNote.includes('mismatch')) {
    return 'warning';
  }
  if (lowerNote.includes('warning')) {
    return 'warning';
  }
  if (lowerNote.includes('error')) {
    return 'warning';
  }
  if (lowerNote.includes('failed')) {
    return 'warning';
  }
  if (lowerNote.includes('empty')) {
    return 'warning';
  }

  // Default to info
  return 'info';
}

export default function InvoiceDetail({ invoice, onClose }: InvoiceDetailProps) {
  if (!invoice) return null;

  const data = invoice.extractedData;
  const status = getValidationStatus(invoice.processingNotes || '');
  const parsedNotes = parseProcessingNotes(invoice.processingNotes || '');

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-2xl overflow-y-auto border-l border-gray-200 bg-white p-6 shadow-xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Invoice Details</h2>
        <button
          onClick={onClose}
          className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Header */}
      <div className="mb-6 rounded-lg bg-gray-50 p-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{invoice.fileName}</h3>
            <p className="mt-1 text-sm text-gray-500">
              Processed: {formatDate(invoice.processedAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ValidationBadge status={status} />
            {invoice.confidenceScore !== undefined && (
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                invoice.confidenceScore >= 0.8
                  ? 'bg-green-100 text-green-800'
                  : invoice.confidenceScore >= 0.5
                    ? 'bg-yellow-100 text-yellow-800'
                    : 'bg-red-100 text-red-800'
              }`}>
                {(invoice.confidenceScore * 100).toFixed(0)}% confidence
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Processing Notes */}
      {parsedNotes.length > 0 && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h4 className="mb-3 text-sm font-semibold text-gray-700">Processing Notes</h4>
          <div className="flex flex-wrap gap-2">
            {parsedNotes.map((note, index) => {
              const noteType = getNoteType(note);
              return (
                <span
                  key={index}
                  className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                    noteType === 'success'
                      ? 'bg-green-100 text-green-800 border border-green-200'
                      : noteType === 'warning'
                        ? 'bg-red-100 text-red-800 border border-red-200'
                        : 'bg-blue-100 text-blue-800 border border-blue-200'
                  }`}
                >
                  {noteType === 'success' && (
                    <svg className="mr-1.5 h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  )}
                  {noteType === 'warning' && (
                    <svg className="mr-1.5 h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  )}
                  {note}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Vendor Info */}
      <div className="mb-6">
        <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
          Vendor Information
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500">Vendor Name</p>
            <p className="font-medium text-gray-900">{data?.vendorName || '-'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Tax ID</p>
            <p className="font-medium text-gray-900">{data?.vendorTaxId || '-'}</p>
          </div>
        </div>
      </div>

      {/* Invoice Info */}
      <div className="mb-6">
        <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
          Invoice Information
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500">Invoice Number</p>
            <p className="font-medium text-gray-900">{data?.invoiceNumber || '-'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Currency</p>
            <p className="font-medium text-gray-900">{data?.currency || '-'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Issue Date</p>
            <p className="font-medium text-gray-900">{formatDate(data?.issueDate as string)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Due Date</p>
            <p className="font-medium text-gray-900">{formatDate(data?.dueDate as string)}</p>
          </div>
        </div>
      </div>

      {/* Line Items */}
      {data?.lineItems && Array.isArray(data.lineItems) && data.lineItems.length > 0 && (
        <div className="mb-6">
          <h4 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Line Items
          </h4>
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Description</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Qty</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Unit Price</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {data.lineItems.map((item: LineItem, index: number) => (
                  <tr key={index}>
                    <td className="px-4 py-2 text-sm text-gray-900">{item.description}</td>
                    <td className="px-4 py-2 text-right text-sm text-gray-500">{item.quantity}</td>
                    <td className="px-4 py-2 text-right text-sm text-gray-500">
                      {formatCurrency(item.unitPrice, data?.currency as string)}
                    </td>
                    <td className="px-4 py-2 text-right text-sm text-gray-900">
                      {formatCurrency(item.total, data?.currency as string)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Totals */}
      <div className="rounded-lg bg-gray-50 p-4">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Subtotal</span>
            <span className="text-gray-900">{formatCurrency(data?.subtotal as number, data?.currency as string)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Tax</span>
            <span className="text-gray-900">{formatCurrency(data?.taxAmount as number, data?.currency as string)}</span>
          </div>
          <div className="flex justify-between border-t border-gray-200 pt-2 text-lg font-bold">
            <span className="text-gray-900">Total</span>
            <span className="text-gray-900">{formatCurrency(data?.totalAmount as number, data?.currency as string)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
