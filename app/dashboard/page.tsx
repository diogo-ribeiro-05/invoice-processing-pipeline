'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ProcessedInvoice, DashboardStats } from '@/lib/types';
import StatsCard from '@/components/StatsCard';
import InvoiceTable from '@/components/InvoiceTable';
import InvoiceDetail from '@/components/InvoiceDetail';

interface ProgressState {
  current: number;
  total: number;
  fileName: string;
  status: string;
  message: string;
}

export default function DashboardPage() {
  const [invoices, setInvoices] = useState<ProcessedInvoice[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<ProcessedInvoice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [stats, setStats] = useState<DashboardStats>({
    totalInvoices: 0,
    matchedVendors: 0,
    flaggedIssues: 0,
    totalsByCurrency: [],
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

      // Calculate totals by currency
      const currencyTotals = new Map<string, number>();
      data.items?.forEach((inv: ProcessedInvoice) => {
        const amount = inv.extractedData?.totalAmount as number;
        const currency = (inv.extractedData?.currency as string) || 'EUR';
        if (typeof amount === 'number') {
          currencyTotals.set(currency, (currencyTotals.get(currency) || 0) + amount);
        }
      });

      const totalsByCurrency = Array.from(currencyTotals.entries())
        .map(([currency, amount]) => ({ currency, amount }))
        .sort((a, b) => b.amount - a.amount);

      setStats({
        totalInvoices: total,
        matchedVendors: matched,
        flaggedIssues: flagged,
        totalsByCurrency,
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
    setSuccessMessage(null)
    setProgress({ current: 0, total: 0, fileName: '', status: '', message: 'Starting...' })

    try {
      const response = await fetch('/api/process-all', { method: 'POST' })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to process invoices')
      }

      // Check if response is JSON (already processed) or streaming
      const contentType = response.headers.get('content-type') || ''

      if (contentType.includes('application/json')) {
        // All invoices already processed - show message directly
        setProgress(null)
        const data = await response.json()
        if (data.alreadyProcessed) {
          setSuccessMessage('All invoices were already processed. Click Reset to process again.')
        }
      } else {
        // Streaming response - read the stream
        const reader = response.body?.getReader()
        const decoder = new TextDecoder()

        if (!reader) {
          throw new Error('No response body')
        }

        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Process complete messages (each line is a JSON object)
          const lines = buffer.split('\n')
          buffer = lines.pop() || '' // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const jsonStr = line.slice(6) // Remove 'data: ' prefix
                const update = JSON.parse(jsonStr)

                if (update.type === 'progress') {
                  setProgress({
                    current: update.current,
                    total: update.total,
                    fileName: update.fileName || '',
                    status: update.status || '',
                    message: update.message || '',
                  })
                } else if (update.type === 'complete') {
                  setProgress({
                    current: update.current,
                    total: update.total,
                    fileName: '',
                    status: 'complete',
                    message: update.message || 'Processing complete!',
                  })

                  if (update.summary) {
                    const { processed } = update.summary
                    if (processed > 0) {
                      setSuccessMessage(`Successfully processed ${processed} invoice(s)`)
                    }
                  }
                } else if (update.type === 'error') {
                  setError(update.message || 'Processing failed')
                }
              } catch (e) {
                console.error('Failed to parse progress update:', line, e)
              }
            }
          }
        }
      }

      await fetchInvoices()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Processing failed')
    } finally {
      setIsProcessing(false)
      setTimeout(() => setProgress(null), 2000) // Hide progress after 2s
    }
  }

  const handleReset = async () => {
    if (!confirm('Are you sure you want to delete all processed invoices?')) return
    setIsLoading(true)
    setSuccessMessage(null)
    setProgress(null)
    try {
      await fetch('/api/erp/processed-invoices', { method: 'DELETE' })
      await fetchInvoices()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    }
  }

  const formatCurrency = (amount: number, currency: string) => {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'EUR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return `${currency} ${amount.toFixed(2)}`;
    }
  }

  const progressPercent = progress ? Math.round((progress.current / progress.total) * 100) : 0

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

        {/* Success Alert */}
        {successMessage && (
          <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4 flex items-center justify-between">
            <p className="text-sm text-green-700">{successMessage}</p>
            <button
              onClick={() => setSuccessMessage(null)}
              className="text-green-700 hover:text-green-900"
            >
              ×
            </button>
          </div>
        )}

        {/* Progress Bar */}
        {progress && (
          <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-blue-700">
                {progress.message}
              </span>
              <span className="text-sm text-blue-600">
                {progress.current} / {progress.total} ({progressPercent}%)
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-blue-200">
              <div
                className="h-full rounded-full bg-blue-600 transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {progress.fileName && (
              <p className="mt-2 text-xs text-blue-600">
                {progress.status === 'processing' ? '⏳' : progress.status === 'processed' ? '✅' : progress.status === 'error' ? '❌' : '⏭️'} {progress.fileName}
              </p>
            )}
          </div>
        )}

        {/* Stats Grid */}
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        </div>

        {/* Currency Breakdown */}
        {stats.totalsByCurrency.length > 0 && (
          <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="mb-4 text-sm font-medium text-gray-500">Total Amounts by Currency</h3>
            <div className="flex flex-wrap gap-6">
              {stats.totalsByCurrency.map(({ currency, amount }) => (
                <div key={currency} className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-gray-900">
                    {formatCurrency(amount, currency)}
                  </span>
                  <span className="text-sm text-gray-500">{currency}</span>
                </div>
              ))}
            </div>
          </div>
        )}

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
