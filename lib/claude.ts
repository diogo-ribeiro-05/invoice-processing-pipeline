import Anthropic from '@anthropic-ai/sdk';
import pdf from 'pdf-parse';
import type { ExtractedData } from './types';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.z.ai/api/anthropic',
});

const MODEL = process.env.ANTHROPIC_MODEL || 'glm-5';

const EXTRACTION_PROMPT = `You are an expert invoice data extraction system. Extract structured data from this invoice.

=== CRITICAL: VENDOR NAME EXTRACTION ===
The VENDOR is the company ISSUING the invoice (the seller/biller).
The CUSTOMER is the company RECEIVING the invoice (the buyer).

STRICT RULES FOR VENDOR NAME:
1. POSITIONING: The Vendor name is typically the FIRST entity mentioned at the absolute top of the document (header). The Customer is usually listed further down, often under labels like "Bill To", "Factuuradres", "Sold To", or simply below the vendor's address. Do NOT extract the Customer as the Vendor.
2. NO REFERENCE CODES: Do not extract alphanumeric order IDs, customer numbers, or document IDs as the Vendor Name. Real company names usually contain natural words and often end with legal entity suffixes (Inc., B.V., Ltd., LLC, Corp., AG, etc.).
3. TABULAR DATA: Never extract the vendor name from data inside tables under columns like "Customer", "Klant", "Order", or "Client".
4. CONTEXTUAL CLUES: Watch for international proxy terms like "iov" or "i.o.v." (in opdracht van = on behalf of) which indicate the actual vendor entity.
5. SHIPPING/CONTACT PERSONS: Names located under "Bill To", "Ship To", "Factuuradres", "Afleveradres", or "Klant" are ALWAYS the CUSTOMER or CONTACT PERSON. NEVER extract them as the Vendor.
6. PLACEHOLDER NAMES: Ignore generic placeholder customer names (e.g., "YourCompany", "Your Company") or lowercase individual contact names - these are NOT the vendor.

=== TAX ID EXTRACTION ===
Look for labels: "VAT", "VAT/TIN", "BTW", "GSTIN", "Tax ID", "TVA", "VAT Number", "BTW-nr"
- The VENDOR's Tax ID is usually near the vendor's company name, footer, or issuer details.
- Labels like "Uw BTW nummer", "Your VAT", or "Customer VAT" indicate the CUSTOMER's tax ID. Do NOT extract these.
- Include country prefixes if present (e.g., FR, NL, DE, US).
- If no vendor tax ID is clearly identifiable, return null.

=== AMOUNT EXTRACTION ===
- Look for "Grand Total", "Total", "Totaal", "Factuur totaal" for the final amount.
- Subtotal is the amount BEFORE tax.
- Verify: subtotal + tax ≈ total.
- Do not include digits from product codes or row numbers.

=== INVOICE NUMBER ===
- Extract the EXACT full string including any letter prefixes, dashes, or slashes.
- Do NOT strip letters from the invoice number (e.g., "INV-2024-001" stays as-is, not "2024001").

=== LINE ITEMS ===
- Extract ALL rows from the items table, including those with a 0.00 price or discount lines.
- Do not skip any items regardless of their value.

=== REQUIRED JSON OUTPUT ===
Return ONLY a JSON object with these exact field names:
{
  "invoiceNumber": "string (exact value, do not strip prefixes)",
  "vendorName": "string",
  "vendorTaxId": "string or null",
  "issueDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD or null",
  "currency": "USD/EUR/INR/etc",
  "subtotal": number,
  "taxAmount": number or null,
  "totalAmount": number,
  "lineItems": [{"description": "string", "quantity": number, "unitPrice": number, "total": number}]
}

INVOICE TEXT:
`;

/**
 * Parse JSON from Claude response, handling markdown code blocks
 */
function parseJsonFromResponse(rawResponse: string): ExtractedData | null {
  try {
    let jsonStr = rawResponse.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();
    return JSON.parse(jsonStr) as ExtractedData;
  } catch {
    return null;
  }
}

/**
 * Calculate confidence based on required fields
 */
function calculateConfidence(data: ExtractedData | null): number {
  if (!data) return 0;
  const requiredFields = ['invoiceNumber', 'vendorName', 'totalAmount', 'currency'];
  const presentFields = requiredFields.filter(
    (field) =>
      data[field as keyof ExtractedData] !== null &&
      data[field as keyof ExtractedData] !== undefined &&
      data[field as keyof ExtractedData] !== ''
  );
  return presentFields.length / requiredFields.length;
}

/**
 * Check if extraction result needs OCR fallback (missing critical data that might be in images)
 */
function needsOcrFallback(data: ExtractedData | null, pdfText: string): boolean {
  if (!data) return true;

  // If vendor tax ID is missing, check if it might be in an image
  if (!data.vendorTaxId) {
    const lowerText = pdfText.toLowerCase();
    // Check if we see customer-related terms but no clear vendor info
    const hasCustomerInfo = lowerText.includes('bill to') ||
                            lowerText.includes('ship to') ||
                            lowerText.includes('customer') ||
                            lowerText.includes('uw') ||
                            lowerText.includes('your');

    // If text is short and has customer info but no vendor tax ID, try OCR
    if (hasCustomerInfo && pdfText.length < 2000) {
      return true;
    }
  }

  return false;
}

/**
 * Extract vendor Tax ID from OCR text using pattern matching
 */
function extractTaxIdFromOcrText(ocrText: string): string | null {
  // Dutch VAT pattern: NL followed by digits and optional dots, then B01/B02 etc
  // Also handles German (DE), French (FR), Belgian (BE) formats
  const vatPatterns = [
    /BTW-nr[:\s]*(NL[\d.\s]+B\d{2})/i,
    /(NL[\d.\s]+B\d{2})/gi,
    /(DE[\d.\s]+B\d{2})/gi,
    /(FR[\d\s]+B\d{2})/gi,
    /(BE[0-9]\.?\d{3}\.?\d{3})/gi,
  ];

  for (const pattern of vatPatterns) {
    const match = ocrText.match(pattern);
    if (match && match[1]) {
      // Normalize the Tax ID - remove spaces, keep dots in proper positions
      return match[1].replace(/\s+/g, '').replace(/\./g, '.');
    }
  }

  return null;
}

/**
 * Extract vendor name from OCR text
 * Uses generic regex to find company names with legal suffixes
 */
function extractVendorNameFromOcrText(ocrText: string): string | null {
  const lines = ocrText.split('\n');

  for (const line of lines) {
    const lowerLine = line.toLowerCase();

    // Skip lines that are clearly customer-related
    if (lowerLine.includes('factuuradres') || lowerLine.includes('klant') || lowerLine.includes('bill to')) {
      continue;
    }

    // Generic pattern to find company names with standard legal suffixes
    // Matches capitalized words followed by B.V., Inc., GmbH, etc.
    const match = line.match(/([A-Z][A-Za-z0-9& .\-]+(?:B\.V\.|Inc\.|GmbH|AG|SAS|Pvt\. Ltd\.|LLC|Corp\.))/i);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Extract invoice data using OCR (Tesseract.js)
 * Converts PDF to image and uses OCR to extract vendor info
 */
async function extractWithOcr(pdfBuffer: Buffer): Promise<{
  vendorName: string | null;
  vendorTaxId: string | null;
}> {
  try {
    // Dynamic import for ESM modules
    const { pdf: pdfToImg } = await import('pdf-to-img');
    const TesseractModule = await import('tesseract.js');
    // Handle both ESM and CommonJS module structures
    const recognize = TesseractModule.recognize || (TesseractModule as any).default?.recognize;

    if (!recognize) {
      console.error('OCR: Could not load Tesseract.recognize function');
      return { vendorName: null, vendorTaxId: null };
    }

    console.log('Starting OCR extraction...');

    // Convert PDF to images
    const pages = await pdfToImg(pdfBuffer, { scale: 2 });
    const pageImages: Buffer[] = [];

    for await (const page of pages) {
      pageImages.push(page);
    }

    if (pageImages.length === 0) {
      return { vendorName: null, vendorTaxId: null };
    }

    console.log(`OCR: Processing ${pageImages.length} page(s)...`);

    // Use first page for OCR
    const ocrResult = await recognize(
      pageImages[0],
      'nld+eng',
      {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            console.log(`OCR progress: ${Math.round(m.progress * 100)}%`);
          }
        }
      }
    );

    const ocrText = ocrResult.data.text;
    console.log('OCR text extracted, length:', ocrText.length);

    // Extract vendor info from OCR text
    const vendorName = extractVendorNameFromOcrText(ocrText);
    const vendorTaxId = extractTaxIdFromOcrText(ocrText);

    console.log('OCR extracted:', { vendorName, vendorTaxId });

    return { vendorName, vendorTaxId };
  } catch (error) {
    console.error('OCR extraction error:', error);
    return { vendorName: null, vendorTaxId: null };
  }
}

/**
 * Extract invoice data from PDF using text parsing + Claude API
 * Falls back to OCR (Tesseract.js) if text extraction is insufficient
 */
export async function extractInvoiceData(pdfBuffer: Buffer): Promise<{
  data: ExtractedData | null;
  confidence: number;
  rawResponse: string;
  error?: string;
}> {
  try {
    // Step 1: Try text extraction first
    const pdfData = await pdf(pdfBuffer);
    const pdfText = pdfData.text;

    if (!pdfText || pdfText.trim().length === 0) {
      return {
        data: null,
        confidence: 0,
        rawResponse: '',
        error: 'No text could be extracted from PDF',
      };
    }

    // Step 2: Process with Claude
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: EXTRACTION_PROMPT + '\n\n' + pdfText + '\n\nReturn ONLY a valid JSON object with no additional text or markdown formatting.',
        },
      ],
    });

    // Extract text from response
    const textBlock = message.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return {
        data: null,
        confidence: 0,
        rawResponse: '',
        error: 'No text response from Claude',
      };
    }

    const rawResponse = textBlock.text;
    let extractedData = parseJsonFromResponse(rawResponse);

    if (!extractedData) {
      return {
        data: null,
        confidence: 0,
        rawResponse,
        error: 'Failed to parse JSON response',
      };
    }

    // Step 3: Check if we need OCR fallback
    if (needsOcrFallback(extractedData, pdfText)) {
      console.log('Text extraction insufficient, trying OCR fallback...');
      const ocrResult = await extractWithOcr(pdfBuffer);

      // OCR regex finds strict legal entity matches, so prefer OCR results over LLM guesses
      // The LLM often extracts contact persons or placeholder names incorrectly
      if (ocrResult.vendorName) {
        extractedData.vendorName = ocrResult.vendorName;
        console.log('OCR provided better vendor name:', ocrResult.vendorName);
      }
      if (ocrResult.vendorTaxId) {
        extractedData.vendorTaxId = ocrResult.vendorTaxId;
        console.log('OCR found vendor tax ID:', ocrResult.vendorTaxId);
      }
    }

    return {
      data: extractedData,
      confidence: calculateConfidence(extractedData),
      rawResponse,
    };
  } catch (error) {
    console.error('Claude extraction error:', error);
    return {
      data: null,
      confidence: 0,
      rawResponse: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function extractInvoiceDataWithRetry(
  pdfBuffer: Buffer,
  maxRetries: number = 2
): Promise<{
  data: ExtractedData | null;
  confidence: number;
  rawResponse: string;
  error?: string;
}> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await extractInvoiceData(pdfBuffer);

    if (result.data) {
      return result;
    }

    lastError = result.error;

    // Wait before retry (exponential backoff)
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }

  return {
    data: null,
    confidence: 0,
    rawResponse: '',
    error: lastError || 'Failed after retries',
  };
}
