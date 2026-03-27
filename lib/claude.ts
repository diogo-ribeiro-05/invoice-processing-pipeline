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

HOW TO IDENTIFY THE VENDOR NAME:
1. Look for company names with legal suffixes: "B.V.", "Inc.", "AG", "SAS", "Pvt. Ltd.", "GmbH", "Ltd.", "Corp", "Corporation"
2. The vendor name appears WITH the company's address (street, city, country)
3. The vendor is often near the TOP of the invoice or in the header
4. Look for labels: "FROM", "SELLER", "VENDOR", "ISSUED BY"

⚠️ WHAT IS NOT A VENDOR NAME:
- Codes like "SCONL", "INV001", "FACT2022" - these are invoice reference codes, NOT company names
- Generic words like "Invoice", "Factuur", "Bill"
- Names that appear in "BILL TO", "SHIP TO", "CUSTOMER" sections - those are CUSTOMERS

EXAMPLES OF CORRECT EXTRACTION:
✅ "Strategic Corp" (real company name with address)
✅ "Coolblue B.V." (company with legal suffix)
✅ "Amazon Web Services, Inc." (company with legal suffix)
❌ "SCONL" (this is an invoice reference code, NOT a company)
❌ "Global Wholesaler" when it appears in a "BILL TO" section (that's the customer)

=== TAX ID EXTRACTION ===

Look for labels: "VAT", "VAT/TIN", "BTW", "GSTIN", "Tax ID", "TVA", "VAT Number"
- Prefer VAT/TIN over Service Tax numbers
- Include country prefix if present: "FR63530848134", "NL810433941B01", "DE232446240"

=== REQUIRED JSON OUTPUT ===

Return ONLY a JSON object with these exact field names:
{
  "invoiceNumber": "string",
  "vendorName": "string (real company name, NOT a code)",
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
 * Extract invoice data from PDF using text parsing + Claude API
 *
 * NOTE: This uses pdf-parse for text extraction (document parsing).
 * For true OCR (reading text from images within PDFs), a server-side
 * solution with pdf-to-image conversion + Claude Vision would be needed.
 *
 * The current approach works well for text-based PDFs where the content
 * is embedded as selectable text.
 */
export async function extractInvoiceData(pdfBuffer: Buffer): Promise<{
  data: ExtractedData | null;
  confidence: number;
  rawResponse: string;
  error?: string;
}> {
  try {
    // Extract text from PDF using pdf-parse (document parsing approach)
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

    // Parse JSON response
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

    const extractedData = JSON.parse(jsonStr) as ExtractedData;

    // Calculate confidence based on required fields
    const requiredFields = ['invoiceNumber', 'vendorName', 'totalAmount', 'currency'];
    const presentFields = requiredFields.filter(
      (field) =>
        extractedData[field as keyof ExtractedData] !== null &&
        extractedData[field as keyof ExtractedData] !== undefined &&
        extractedData[field as keyof ExtractedData] !== ''
    );
    const confidence = presentFields.length / requiredFields.length;

    return {
      data: extractedData,
      confidence,
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
