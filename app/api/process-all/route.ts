import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { extractInvoiceDataWithRetry, rateLimitDelay, GEMINI_RATE_LIMIT_MS } from '@/lib/claude';
import { getCompanies, validateVendor, submitProcessedInvoice, getProcessedInvoices } from '@/lib/erp-api';

export const dynamic = 'force-dynamic';

// Log rate limit config on startup
console.log(`[Process All] Rate limit delay: ${GEMINI_RATE_LIMIT_MS}ms between invoices`);

interface ProgressUpdate {
  type: 'progress' | 'complete' | 'error';
  current: number;
  total: number;
  fileName?: string;
  status?: 'processing' | 'processed' | 'skipped' | 'error';
  message?: string;
  summary?: {
    total: number;
    processed: number;
    skipped: number;
    errors: number;
  };
}

export async function POST() {
  try {
    const invoicesDir = path.join(process.cwd(), 'invoices');

    if (!fs.existsSync(invoicesDir)) {
      return NextResponse.json({ error: 'Invoices directory not found' }, { status: 404 });
    }

    const files = fs.readdirSync(invoicesDir).filter((f) => f.endsWith('.pdf'));

    if (files.length === 0) {
      return NextResponse.json({ error: 'No PDF files found' }, { status: 400 });
    }

    // Get already processed invoices
    const existingInvoices = await getProcessedInvoices();
    const existingFileNames = new Set(existingInvoices.items.map((inv) => inv.fileName));

    // Check if all already processed
    const filesToProcess = files.filter((f) => !existingFileNames.has(f));
    const skippedCount = files.length - filesToProcess.length;

    if (filesToProcess.length === 0) {
      return NextResponse.json({
        success: true,
        alreadyProcessed: true,
        message: 'All invoices have already been processed. Click Reset to process again.',
        summary: { total: files.length, processed: 0, skipped: skippedCount, errors: 0 },
      });
    }

    // Get companies for validation
    const companies = await getCompanies();

    // Create a streaming response
    const encoder = new TextEncoder();
    let current = 0;
    let processed = 0;
    let errors = 0;

    const stream = new ReadableStream({
      async start(controller) {
        const sendProgress = (update: ProgressUpdate) => {
          const data = `data: ${JSON.stringify(update)}\n\n`;
          controller.enqueue(encoder.encode(data));
        };

        // Send initial status
        sendProgress({
          type: 'progress',
          current: 0,
          total: files.length,
          message: `Found ${filesToProcess.length} invoices to process...`,
        });

        // Process files sequentially to ensure ALL files are processed
        for (const fileName of filesToProcess) {
          current++;

          // Rate limiting: wait between invoices to avoid Gemini API limits
          // Skip delay on first invoice (no previous API call to rate limit against)
          if (current > 1) {
            sendProgress({
              type: 'progress',
              current,
              total: files.length,
              fileName,
              status: 'processing',
              message: `Rate limiting... waiting ${GEMINI_RATE_LIMIT_MS / 1000}s before processing ${fileName}...`,
            });
            await rateLimitDelay();
          }

          sendProgress({
            type: 'progress',
            current,
            total: files.length,
            fileName,
            status: 'processing',
            message: `Processing ${fileName}...`,
          });

          try {
            const filePath = path.join(invoicesDir, fileName);
            const pdfBuffer = fs.readFileSync(filePath);
            const extractionResult = await extractInvoiceDataWithRetry(pdfBuffer);

            if (!extractionResult.data) {
              errors++;
              sendProgress({
                type: 'progress',
                current,
                total: files.length,
                fileName,
                status: 'error',
                message: `Failed to extract data from ${fileName}`,
              });
              continue;
            }

            const extractedData = extractionResult.data;
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

            let adjustedConfidence = extractionResult.confidence + (validation.confidenceAdjustment || 0);
            adjustedConfidence = Math.max(0, Math.min(1, adjustedConfidence));

            // Filter out empty or meaningless notes and join
            const meaningfulNotes = validation.notes.filter(note =>
              note && note.trim().length > 2 && !/^[A-Za-z]\.?$/.test(note.trim())
            );
            const processingNotes = meaningfulNotes.join('; ');

            await submitProcessedInvoice({
              fileName,
              extractedData,
              confidenceScore: adjustedConfidence,
              processingNotes,
            });

            processed++;
            sendProgress({
              type: 'progress',
              current,
              total: files.length,
              fileName,
              status: 'processed',
              message: `Processed ${fileName}`,
            });
          } catch (error) {
            errors++;
            sendProgress({
              type: 'progress',
              current,
              total: files.length,
              fileName,
              status: 'error',
              message: `Error processing ${fileName}: ${error instanceof Error ? error.message : 'Unknown'}`,
            });
          }
        }

        // Send completion
        sendProgress({
          type: 'complete',
          current: files.length,
          total: files.length,
          summary: {
            total: files.length,
            processed,
            skipped: skippedCount,
            errors,
          },
          message: `Completed! ${processed} processed, ${skippedCount} skipped, ${errors} errors.`,
        });

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Batch process error:', error);
    return NextResponse.json(
      { error: 'Failed to process invoices', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
