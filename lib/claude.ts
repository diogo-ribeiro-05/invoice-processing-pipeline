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

The VENDOR is the company ISSUING the invoice (the seller, receiving payment).
The CUSTOMER is the company RECEIVING the invoice (the buyer, making payment).

STRICT RULES FOR VENDOR NAME - READ CAREFULLY:

1. NEVER extract alphanumeric order codes, customer codes, document IDs, or strings like "SCONL...", "INV...", "ORD..." as the Vendor Name. These are reference codes, NOT company names.

2. Vendor names are typically standard company names found at:
   - The very TOP of the document (headers), often next to a logo
   - The BOTTOM of the document next to company registration details
   - Look for company names with legal suffixes: "B.V.", "Inc.", "AG", "SAS", "Pvt. Ltd.", "GmbH", "Ltd."

3. Watch for Dutch terms like "iov" or "i.o.v." (in opdracht van = on behalf of) which indicate the vendor. For example, "e-Luscious Nederland B.V. iov Saeco.com" means the vendor is "Saeco" or "e-Luscious Nederland B.V."

4. Do NOT extract names from tabular data under columns like "Klant", "Customer", "Order", "Debtor" - these are CUSTOMER fields, not vendor.

5. If you see a company name repeated with a logo (like "Saeco" at the top), that is the vendor name.

EXAMPLES OF CORRECT VENDOR EXTRACTION:
✅ "Saeco" or "e-Luscious Nederland B.V." (not "SCONL0303006280999")
✅ "Coolblue B.V." (not a customer code)
✅ "Amazon Web Services, Inc." (not "AWS-12345")

=== TAX ID EXTRACTION ===

Look for labels: "VAT", "VAT/TIN", "BTW", "GSTIN", "Tax ID", "TVA", "VAT Number", "BTW nummer"

CRITICAL: VENDOR vs CUSTOMER TAX ID
- The VENDOR's Tax ID is usually near the vendor's company name/address
- Look for labels like "Our VAT", "Our BTW", "VAT Number", "BTW-nr" (without "Uw" or "Your")
- Labels like "Uw BTW nummer", "Your VAT", "Customer VAT" indicate the CUSTOMER's tax ID - NOT the vendor's
- If you see "Uw BTW nummer" or similar, that is NOT the vendor tax ID

IMPORTANT:
- Prefer VAT/TIN over Service Tax numbers
- Include country prefix if present: "FR63530848134", "NL810433941B01", "DE232446240"
- If no vendor tax ID is clearly identifiable, return null

=== AMOUNT EXTRACTION FROM TABLE LAYOUTS ===

PDF text extraction often jumbles table columns. Be careful when extracting amounts:
- Look for "Grand Total", "Total", "Totaal", "Factuur totaal" as the final amount
- The subtotal should be the amount BEFORE tax
- Tax amount is usually labeled "Tax", "BTW", "VAT", "CST"
- Verify: subtotal + tax ≈ total (allow small rounding differences)

COMMON EXTRACTION ERRORS TO AVOID:
- Don't include digits from row numbers or product codes in amounts
- If you see "1278.61" but "Grand Total: 319.00", the correct total is 319.00
- Numbers appearing before "%CST" or similar are often tax percentages, not amounts

=== REQUIRED JSON OUTPUT ===

Return ONLY a JSON object with these exact field names:
{
  "invoiceNumber": "string",
  "vendorName": "string (real company name like 'Saeco', NOT codes like 'SCONL...')",
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
 * Looks for company names with legal suffixes near issuer section
 */
function extractVendorNameFromOcrText(ocrText: string): string | null {
  const lines = ocrText.split('\n');

  for (const line of lines) {
    const lowerLine = line.toLowerCase();

    // Skip lines that are clearly customer-related
    if (lowerLine.includes('factuuradres') || lowerLine.includes('klant')) {
      continue;
    }

    // Look for issuer indicators
    if (lowerLine.includes('e-luscious') || lowerLine.includes('saeco')) {
      // Extract company name with suffix
      const match = line.match(/([A-Za-z][A-Za-z0-9 ]+(?:B\.V\.|Inc\.|GmbH|AG|SAS|Pvt\. Ltd\.))/i);
      if (match) {
        return match[1].trim();
      }
    }
  }

  // Fallback: look for any B.V. company
  const bvMatch = ocrText.match(/([A-Za-z][A-Za-z0-9 ]+(?:B\.V\.|Inc\.|GmbH|AG))/);
  if (bvMatch) {
    return bvMatch[1].trim();
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

      // Use OCR result if it provides more complete data
      if (ocrResult.vendorName && !extractedData.vendorName) {
        extractedData.vendorName = ocrResult.vendorName;
        console.log('OCR provided better vendor name:', ocrResult.vendorName);
      }
      if (ocrResult.vendorTaxId && !extractedData.vendorTaxId) {
        extractedData.vendorTaxId = ocrResult.vendorTaxId;
        console.log('OCR found vendor tax ID:', ocrResult.vendorTaxId);
      } else {
        console.log('OCR did not improve data, keeping text extraction result');
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
