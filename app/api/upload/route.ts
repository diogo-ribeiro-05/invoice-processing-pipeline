import { NextRequest, NextResponse } from 'next/server';
import { extractInvoiceDataWithRetry } from '@/lib/claude';
import { submitProcessedInvoice, validateVendor, getCompanies } from '@/lib/erp-api';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: 'No files uploaded' },
        { status: 400 }
      );
    }

    // Get companies for validation
    const companies = await getCompanies();

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const file of files) {
      try {
        // Validate file type
        if (file.type !== 'application/pdf') {
          errors.push(`${file.name}: Not a PDF file`);
          failed++;
          continue;
        }

        // Convert File to Buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Extract data from PDF
        const result = await extractInvoiceDataWithRetry(buffer);

        if (!result.data) {
          errors.push(`${file.name}: ${result.error || 'Extraction failed'}`);
          failed++;
          continue;
        }

        // Validate vendor against ERP
        const validation = validateVendor(
          result.data.vendorName,
          result.data.vendorTaxId,
          companies,
          {
            subtotal: result.data.subtotal,
            taxAmount: result.data.taxAmount,
            totalAmount: result.data.totalAmount,
          }
        );

        // Build processing notes
        const notes: string[] = [];
        if (validation.taxIdMatched) {
          notes.push('Tax ID matched to company records');
        }
        if (validation.vendorMatched && !validation.taxIdMatched) {
          notes.push('Vendor name matched to company records');
        }
        if (validation.mathError) {
          notes.push(validation.notes.find(n => n.includes('Math error')) || 'Math error detected');
        }
        if (!validation.vendorMatched && !validation.taxIdMatched) {
          notes.push('Vendor not found in company records');
        }
        if (!result.data.vendorTaxId) {
          notes.push('Tax ID missing from invoice');
        }
        if (validation.status === 'matched') {
          notes.push('Vendor fully validated');
        }

        // Submit to ERP
        await submitProcessedInvoice({
          fileName: file.name,
          extractedData: result.data,
          confidenceScore: Math.max(0, Math.min(1, result.confidence + validation.confidenceAdjustment)),
          processingNotes: notes.join('. '),
        });

        processed++;
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        failed++;
      }
    }

    return NextResponse.json({
      success: true,
      total: files.length,
      processed,
      failed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
