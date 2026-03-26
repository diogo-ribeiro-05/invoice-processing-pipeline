'use client';

import type { ProcessedInvoice } from '@/lib/types';
import ValidationBadge from './ValidationBadge';

interface InvoiceTableProps {
  invoices: ProcessedInvoice[];
  onSelectInvoice: (invoice: ProcessedInvoice) => void;
  selectedId?: string;
  isLoading?: boolean;
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString();
  } catch {
    return dateStr;
  }
}

function getValidationStatus(invoice: ProcessedInvoice): 'matched' | 'mismatched' | 'unknown' {
  const notes = invoice.processingNotes?.toLowerCase() || '';
  if (notes.includes('fully validated') || notes.includes('matched')) {
    if (notes.includes('warning') || notes.includes('mismatch')) {
      return 'mismatched';
    }
    return 'matched';
  }
  if (notes.includes('not found') || notes.includes('unknown')) {
    return 'unknown';
  }
  return 'unknown';
}

export default function InvoiceTable({
  invoices,
  onSelectInvoice,
  selectedId,
  isLoading,
}: InvoiceTableProps) {
  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
        <div className="animate-pulse text-gray-500">Loading invoices...</div>
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
        <p className="text-gray-500">No invoices processed yet.</p>
        <p className="mt-2 text-sm text-gray-400">
          Upload invoices or click &quot;Process All&quot; to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              File
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Vendor
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Invoice #
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Amount
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              Date
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {invoices.map((invoice) => (
            <tr
              key={invoice.id}
              onClick={() => onSelectInvoice(invoice)}
              className={`cursor-pointer transition-colors hover:bg-gray-50 ${
                selectedId === invoice.id ? 'bg-blue-50' : ''
              }`}
            >
              <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-gray-900">
                {invoice.fileName}
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                {invoice.extractedData?.vendorName || '-'}
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                {invoice.extractedData?.invoiceNumber || '-'}
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-900">
                {invoice.extractedData?.totalAmount !== undefined
                  ? formatCurrency(
                      invoice.extractedData.totalAmount as number,
                      invoice.extractedData?.currency as string
                    )
                  : '-'}
              </td>
              <td className="whitespace-nowrap px-6 py-4">
                <ValidationBadge status={getValidationStatus(invoice)} />
              </td>
              <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                {invoice.processedAt ? formatDate(invoice.processedAt) : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
