import { NextRequest } from 'next/server';
import { extractInvoiceDataWithRetry, rateLimitDelay, GEMINI_RATE_LIMIT_MS } from '@/lib/claude';
import { submitProcessedInvoice, validateVendor, getCompanies, getProcessedInvoices } from '@/lib/erp-api';

// Helper to send SSE messages
function sendMessage(controller: ReadableStreamDefaultController, data: object) {
  controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return new Response(JSON.stringify({ error: 'No files uploaded' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create a streaming response
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Get companies for validation
          sendMessage(controller, { type: 'status', message: 'Loading vendor data...' });
          const companies = await getCompanies();

          // Get existing invoices to check for duplicates
          sendMessage(controller, { type: 'status', message: 'Checking for duplicates...' });
          const existingInvoices = await getProcessedInvoices();
          const existingFileNames = new Set(existingInvoices.items.map((inv) => inv.fileName));
          const existingInvoiceNumbers = new Set(
            existingInvoices.items
              .map((inv) => (inv.extractedData as { invoiceNumber?: string })?.invoiceNumber)
              .filter(Boolean)
          );

          let processed = 0;
          let skipped = 0;
          let failed = 0;
          const errors: string[] = [];
          const skippedFiles: string[] = [];

          // Process files sequentially with progress updates
          for (let i = 0; i < files.length; i++) {
            const file = files[i];

            // Rate limiting: wait between invoices to avoid Gemini API limits
            // Skip delay on first file (no previous API call to rate limit against)
            if (i > 0) {
              sendMessage(controller, {
                type: 'status',
                message: `Rate limiting... waiting ${GEMINI_RATE_LIMIT_MS / 1000}s...`,
              });
              await rateLimitDelay();
            }

            // Send progress update
            sendMessage(controller, {
              type: 'progress',
              current: i + 1,
              total: files.length,
              fileName: file.name,
              status: 'processing',
              message: `Processing ${file.name}...`,
            });

            try {
              // Validate file type
              if (file.type !== 'application/pdf') {
                errors.push(`${file.name}: Not a PDF file`);
                failed++;
                sendMessage(controller, {
                  type: 'progress',
                  current: i + 1,
                  total: files.length,
                  fileName: file.name,
                  status: 'error',
                  message: `${file.name}: Not a PDF file`,
                });
                continue;
              }

              // Check for duplicate by file name
              if (existingFileNames.has(file.name)) {
                skippedFiles.push(`${file.name}: Already processed`);
                skipped++;
                sendMessage(controller, {
                  type: 'progress',
                  current: i + 1,
                  total: files.length,
                  fileName: file.name,
                  status: 'skipped',
                  message: `${file.name}: Skipped (already processed)`,
                });
                continue;
              }

              // Convert File to Buffer
              const arrayBuffer = await file.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);

              // Extract data from PDF
              sendMessage(controller, {
            type: 'progress',
            current: i + 1,
            total: files.length,
            fileName: file.name,
            status: 'extracting',
            message: `Extracting data from ${file.name}...`,
          });

              const result = await extractInvoiceDataWithRetry(buffer);

              if (!result.data) {
                errors.push(`${file.name}: ${result.error || 'Extraction failed'}`);
                failed++;
                sendMessage(controller, {
                  type: 'progress',
                  current: i + 1,
                  total: files.length,
                  fileName: file.name,
                  status: 'error',
                  message: `${file.name}: Extraction failed`,
                });
                continue;
              }

              // Check if extraction returned valid invoice data
              const hasInvoiceNumber = !!result.data.invoiceNumber;
              const hasVendorName = !!result.data.vendorName;
              const hasTotalAmount = result.data.totalAmount !== undefined && result.data.totalAmount !== null;

              if (!hasInvoiceNumber || !hasVendorName || !hasTotalAmount) {
                errors.push(`${file.name}: Not a valid invoice (missing invoice number, vendor name, or total amount)`);
                failed++;
                sendMessage(controller, {
                  type: 'progress',
                  current: i + 1,
                  total: files.length,
                  fileName: file.name,
                  status: 'error',
                  message: `${file.name}: Not a valid invoice`,
                });
                continue;
              }

              // Check for duplicate by invoice number
              if (result.data.invoiceNumber && existingInvoiceNumbers.has(result.data.invoiceNumber)) {
                skippedFiles.push(`${file.name}: Duplicate invoice #${result.data.invoiceNumber}`);
                skipped++;
                sendMessage(controller, {
                  type: 'progress',
                  current: i + 1,
                  total: files.length,
                  fileName: file.name,
                  status: 'skipped',
                  message: `${file.name}: Skipped (duplicate invoice #${result.data.invoiceNumber})`,
                });
                continue;
              }

              // Validate vendor against ERP
              sendMessage(controller, {
            type: 'progress',
            current: i + 1,
            total: files.length,
            fileName: file.name,
            status: 'validating',
            message: `Validating vendor for ${file.name}...`,
          });

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
              sendMessage(controller, {
            type: 'progress',
            current: i + 1,
            total: files.length,
            fileName: file.name,
            status: 'submitting',
            message: `Submitting ${file.name} to ERP...`,
          });

              await submitProcessedInvoice({
                fileName: file.name,
                extractedData: result.data,
                confidenceScore: Math.max(0, Math.min(1, result.confidence + validation.confidenceAdjustment)),
                processingNotes: notes.join('; '),
              });

              processed++;
              sendMessage(controller, {
                type: 'progress',
                current: i + 1,
                total: files.length,
                fileName: file.name,
                status: 'processed',
                message: `${file.name}: Successfully processed`,
              });
            } catch (error) {
              errors.push(`${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
              failed++;
              sendMessage(controller, {
                type: 'progress',
                current: i + 1,
                total: files.length,
                fileName: file.name,
                status: 'error',
                message: `${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
              });
            }
          }

          // Send completion message
          sendMessage(controller, {
            type: 'complete',
            message: 'Processing complete!',
            summary: { total: files.length, processed, skipped, failed },
            errors: errors.length > 0 ? errors : undefined,
            skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
          });

          controller.close();
        } catch (error) {
          sendMessage(controller, {
            type: 'error',
            message: error instanceof Error ? error.message : 'Processing failed',
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Upload failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
