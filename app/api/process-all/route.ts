import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { extractInvoiceDataWithRetry } from '@/lib/claude';
import { getCompanies, validateVendor, submitProcessedInvoice } from '@/lib/erp-api';
import type { InvoiceWithStatus } from '@/lib/types';

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
        { status: 404 }
      );
    }

    // Get companies for validation (once for all invoices)
    const companies = await getCompanies();

    const results: InvoiceWithStatus[] = [];

    for (const fileName of files) {
      const filePath = path.join(invoicesDir, fileName);
      const pdfBuffer = fs.readFileSync(filePath);

      try {
        // Extract data
        const extractionResult = await extractInvoiceDataWithRetry(pdfBuffer);

        if (!extractionResult.data) {
          results.push({
            id: fileName,
            fileName,
            status: 'error',
            error: extractionResult.error || 'Extraction failed',
          });
          continue;
        }

        const extractedData = extractionResult.data;

        // Validate vendor
        const validation = validateVendor(
          extractedData.vendorName,
          extractedData.vendorTaxId || '',
          companies
        );

        // Build processing notes
        const processingNotes = [
          ...validation.notes,
          `Confidence: ${(extractionResult.confidence * 100).toFixed(0)}%`,
        ].join('; ');

        // Submit to ERP
        try {
          await submitProcessedInvoice({
            fileName,
            extractedData: extractedData as unknown as Record<string, unknown>,
            confidenceScore: extractionResult.confidence,
            processingNotes,
          });

          results.push({
            id: fileName,
            fileName,
            status: 'processed',
            extractedData,
            validation,
            confidenceScore: extractionResult.confidence,
            processingNotes,
          });
        } catch (submitError) {
          results.push({
            id: fileName,
            fileName,
            status: 'error',
            extractedData,
            validation,
            error: `Submit failed: ${submitError instanceof Error ? submitError.message : 'Unknown'}`,
          });
        }
      } catch (error) {
        results.push({
          id: fileName,
          fileName,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const summary = {
      total: files.length,
      processed: results.filter((r) => r.status === 'processed').length,
      errors: results.filter((r) => r.status === 'error').length,
    };

    return NextResponse.json({
      success: true,
      summary,
      results,
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
