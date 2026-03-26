import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { extractInvoiceDataWithRetry } from '@/lib/claude';
import { getCompanies, validateVendor, submitProcessedInvoice, getProcessedInvoices } from '@/lib/erp-api';
import type { InvoiceWithStatus } from '@/lib/types';

// Process with concurrency limit to avoid overwhelming the API
async function processWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function processNext(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      const result = await processor(items[currentIndex]);
      results[currentIndex] = result;
    }
  }

  // Start concurrent workers
  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => processNext());

  await Promise.all(workers);
  return results;
}

export async function POST() {
  try {
    const invoicesDir = path.join(process.cwd(), 'invoices');

    if (!fs.existsSync(invoicesDir)) {
      return NextResponse.json(
        { error: 'Invoices directory not found' },
        { status: 404 }
      );
    }

    const files = fs.readdirSync(invoicesDir).filter((f) => f.endsWith('.pdf'));

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No PDF files found in invoices directory' },
        { status: 400 }
      );
    }

    // Get already processed invoices to avoid duplicates
    const existingInvoices = await getProcessedInvoices();
    const existingFileNames = new Set(existingInvoices.items.map((inv) => inv.fileName));

    // Check if all files are already processed
    const filesToProcess = files.filter((f) => !existingFileNames.has(f));
    const skippedCount = files.length - filesToProcess.length;

    if (filesToProcess.length === 0) {
      return NextResponse.json({
        success: true,
        alreadyProcessed: true,
        message: 'All invoices have already been processed. Click Reset to process again.',
        summary: {
          total: files.length,
          processed: 0,
          skipped: skippedCount,
          errors: 0,
        },
        results: files.map((fileName) => ({
          id: fileName,
          fileName,
          status: 'skipped',
          message: 'Already processed',
        })),
      });
    }

    // Get companies for validation
    const companies = await getCompanies();

    // Process files in parallel with concurrency of 3
    const processFile = async (fileName: string): Promise<InvoiceWithStatus> => {
      try {
        const filePath = path.join(invoicesDir, fileName);
        const pdfBuffer = fs.readFileSync(filePath);

        const extractionResult = await extractInvoiceDataWithRetry(pdfBuffer);

        if (!extractionResult.data) {
          return {
            id: fileName,
            fileName,
            status: 'error',
            error: extractionResult.error || 'Extraction failed',
          };
        }

        const extractedData = extractionResult.data;

        // Validate vendor (pass extracted data for math validation)
        const validation = validateVendor(
          extractedData.vendorName,
          extractedData.vendorTaxId || '',
          companies,
          {
            subtotal: extractedData.subtotal,
            taxAmount: extractedData.taxAmount,
            totalAmount: extractedData.totalAmount,
          }
        );

        // Adjust confidence score based on validation
        let adjustedConfidence = extractionResult.confidence + (validation.confidenceAdjustment || 0);
        adjustedConfidence = Math.max(0, Math.min(1, adjustedConfidence));

        // Build processing notes
        const processingNotes = [
          ...validation.notes,
          `Confidence: ${(adjustedConfidence * 100).toFixed(0)}%`,
        ].join('; ');

        // Submit to ERP
        try {
          await submitProcessedInvoice({
            fileName,
            extractedData,
            confidenceScore: adjustedConfidence,
            processingNotes,
          });

          return {
            id: fileName,
            fileName,
            status: 'processed',
            extractedData,
            validation,
          };
        } catch (submitError) {
          return {
            id: fileName,
            fileName,
            status: 'error',
            extractedData,
            validation,
            error: `Submit failed: ${submitError instanceof Error ? submitError.message : 'Unknown'}`,
          };
        }
      } catch (error) {
        return {
          id: fileName,
          fileName,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    };

    // Process in parallel with concurrency limit of 3
    const processedResults = await processWithConcurrency(filesToProcess, 3, processFile);

    // Combine skipped and processed results
    const skippedResults: InvoiceWithStatus[] = files
      .filter((f) => existingFileNames.has(f))
      .map((fileName) => ({
        id: fileName,
        fileName,
        status: 'skipped' as const,
        message: 'Already processed',
      }));

    const allResults = [...skippedResults, ...processedResults];

    const summary = {
      total: files.length,
      processed: processedResults.filter((r) => r.status === 'processed').length,
      skipped: skippedCount,
      errors: processedResults.filter((r) => r.status === 'error').length,
    };

    return NextResponse.json({
      success: true,
      summary,
      results: allResults,
    });
  } catch (error) {
    console.error('Batch process error:', error);
    return NextResponse.json(
      {
        error: 'Failed to process invoices',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
