'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ProcessedInvoice, DashboardStats } from '@/lib/types';
import StatsCard from '@/components/StatsCard';
import InvoiceTable from '@/components/InvoiceTable';
import InvoiceDetail from '@/components/InvoiceDetail';

export default function DashboardPage() {
  const [invoices, setInvoices] = useState<ProcessedInvoice[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<ProcessedInvoice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DashboardStats>({
    totalInvoices: 0,
    matchedVendors: 0,
    flaggedIssues: 0,
    totalAmount: 0,
    currency: 'EUR',
  });

  const fetchInvoices = useCallback(async () => {
    try {
      const response = await fetch('/api/erp/processed-invoices');
      if (!response.ok) throw new Error('Failed to fetch invoices');
      const data = await response.json();
      setInvoices(data.items || []);

      // Calculate stats
      const total = data.items?.length || 0;
      const matched = data.items?.filter((inv: ProcessedInvoice) => {
        const notes = inv.processingNotes?.toLowerCase() || '';
        // Only count as matched if "fully validated" AND no warnings/issues
        return notes.includes('fully validated') &&
               !notes.includes('not found') &&
               !notes.includes('missing') &&
               !notes.includes('mismatch') &&
               !notes.includes('error');
        }
      ).length || 0;
      // Everything else is flagged
      const flagged = total - matched;

      const totalAmount = data.items?.reduce((sum: number, inv: ProcessedInvoice) => {
        const amount = inv.extractedData?.totalAmount as number;
        return sum + (typeof amount === 'number' ? amount : 0);
      }, 0) || 0;

      setStats({
        totalInvoices: total,
        matchedVendors: matched,
        flaggedIssues: flagged,
        totalAmount,
        currency: 'EUR',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoices')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInvoices()
  }, [fetchInvoices])

  const handleProcessAll = async () => {
    setIsProcessing(true)
    setError(null)
    try {
      const response = await fetch('/api/process-all', { method: 'POST' })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to process invoices')
      }
      await fetchInvoices()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Processing failed')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleReset = async () => {
    if (!confirm('Are you sure you want to delete all processed invoices?')) return
    setIsLoading(true)
    try {
      await fetch('/api/erp/processed-invoices', { method: 'DELETE' })
      await fetchInvoices()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    }
  }

  const formatTotalAmount = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: stats.currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Invoice Processing Pipeline</h1>
            <p className="mt-1 text-sm text-gray-500">Portline Logistics - Finance Dashboard</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleReset}
              disabled={isLoading || isProcessing}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Reset
            </button>
            <button
              onClick={handleProcessAll}
              disabled={isLoading || isProcessing}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isProcessing ? 'Processing...' : 'Process All Invoices'}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Error Alert */}
        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Stats Grid */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatsCard
            title="Total Invoices"
            value={stats.totalInvoices}
            subtitle="processed"
            color="blue"
          />
          <StatsCard
            title="Matched Vendors"
            value={stats.matchedVendors}
            subtitle="validated"
            color="green"
          />
          <StatsCard
            title="Flagged Issues"
            value={stats.flaggedIssues}
            subtitle="need attention"
            color="yellow"
          />
          <StatsCard
            title="Total Amount"
            value={formatTotalAmount(stats.totalAmount)}
            subtitle="all invoices"
            color="gray"
          />
        </div>

        {/* Invoices Table */}
        <div className="relative">
          <InvoiceTable
            invoices={invoices}
            onSelectInvoice={setSelectedInvoice}
            selectedId={selectedInvoice?.id}
            isLoading={isLoading}
          />

          {/* Invoice Detail Sidebar */}
          {selectedInvoice && (
            <InvoiceDetail
              invoice={selectedInvoice}
              onClose={() => setSelectedInvoice(null)}
            />
          )}
        </div>
      </main>
    </div>
  )
}
