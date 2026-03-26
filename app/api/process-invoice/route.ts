import { NextRequest, NextResponse } from 'next/server';
import { extractInvoiceDataWithRetry } from '@/lib/claude';
import { getCompanies, validateVendor, submitProcessedInvoice } from '@/lib/erp-api';
import type { ExtractedData } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fileName = formData.get('fileName') as string | null;
    const autoSubmit = formData.get('autoSubmit') === 'true';

    if (!file && !fileName) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    let pdfBuffer: Buffer;

    if (file) {
      const arrayBuffer = await file.arrayBuffer();
      pdfBuffer = Buffer.from(arrayBuffer);
    } else {
      // Load from invoices directory
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.join(process.cwd(), 'invoices', fileName as string);

      if (!fs.existsSync(filePath)) {
        return NextResponse.json(
          { error: `File not found: ${fileName}` },
          { status: 404 }
        );
      }

      pdfBuffer = fs.readFileSync(filePath);
    }

    // Extract data using Claude
    const extractionResult = await extractInvoiceDataWithRetry(pdfBuffer);

    if (!extractionResult.data) {
      return NextResponse.json(
        {
          error: 'Failed to extract invoice data',
          details: extractionResult.error,
          rawResponse: extractionResult.rawResponse,
        },
        { status: 422 }
      );
    }

    const extractedData = extractionResult.data;

    // Get companies for validation
    const companies = await getCompanies();

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

    // Auto-submit if requested
    let submittedInvoice = null;
    if (autoSubmit) {
      try {
        submittedInvoice = await submitProcessedInvoice({
          fileName: fileName || (file?.name || 'unknown.pdf'),
          extractedData: extractedData as unknown as Record<string, unknown>,
          confidenceScore: extractionResult.confidence,
          processingNotes,
        });
      } catch (submitError) {
        console.error('Failed to submit invoice:', submitError);
      }
    }

    return NextResponse.json({
      success: true,
      extractedData,
      validation,
      confidence: extractionResult.confidence,
      processingNotes,
      submitted: !!submittedInvoice,
      invoiceId: submittedInvoice?.id,
    });
  } catch (error) {
    console.error('Process invoice error:', error);
    return NextResponse.json(
      {
        error: 'Failed to process invoice',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
