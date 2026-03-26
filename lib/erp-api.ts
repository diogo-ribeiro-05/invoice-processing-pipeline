import type { Company, ProcessedInvoice, DeleteResponse, ExtractedData } from './types';

const ERP_API_BASE_URL = process.env.ERP_API_BASE_URL || 'https://backend-production-4c89.up.railway.app/api/erp';
const ERP_API_KEY = process.env.ERP_API_KEY || '';

async function fetchERP<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${ERP_API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'X-ERP-API-Key': ERP_API_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ERP API Error: ${response.status} - ${error}`);
  }

  return response.json();
}

export async function getCompanies(): Promise<Company[]> {
  return fetchERP<Company[]>('/companies');
}

export async function getProcessedInvoices(): Promise<{ items: ProcessedInvoice[]; total: number }> {
  return fetchERP<{ items: ProcessedInvoice[]; total: number }>('/processed-invoices');
}

export async function submitProcessedInvoice(invoice: {
  fileName: string;
  extractedData: Record<string, unknown> | ExtractedData;
  confidenceScore?: number;
  processingNotes?: string;
}): Promise<ProcessedInvoice> {
  return fetchERP<ProcessedInvoice>('/processed-invoices', {
    method: 'POST',
    body: JSON.stringify(invoice),
  });
}

export async function deleteAllProcessedInvoices(): Promise<DeleteResponse> {
  return fetchERP<DeleteResponse>('/processed-invoices', {
    method: 'DELETE',
  });
}

// Normalize tax ID by removing spaces, dots, dashes and converting to uppercase
function normalizeTaxId(taxId: string): string {
  return taxId.replace(/[\s.\-]/g, '').toUpperCase();
}

// Check if there's a math error in the invoice amounts
export function checkMathError(
  subtotal: number | null | undefined,
  taxAmount: number | null | undefined,
  totalAmount: number | null | undefined
): { hasError: boolean; message: string } {
  // If any value is missing, we can't check math
  if (subtotal == null || totalAmount == null) {
    return { hasError: false, message: '' };
  }

  // Tax can be 0 or missing, default to 0
  const tax = taxAmount || 0;
  const calculatedTotal = subtotal + tax;

  // Allow small rounding differences (0.02 tolerance)
  const tolerance = 0.02;
  const difference = Math.abs(calculatedTotal - totalAmount);

  if (difference > tolerance) {
    return {
      hasError: true,
      message: `Math error detected: Subtotal (${subtotal}) + Tax (${tax}) = ${calculatedTotal.toFixed(2)}, but Total shows ${totalAmount}`,
    };
  }

  return { hasError: false, message: '' };
}

// Vendor validation helper
export function validateVendor(
  vendorName: string | null | undefined,
  vendorTaxId: string | null | undefined,
  companies: Company[],
  extractedData?: {
    subtotal?: number | null;
    taxAmount?: number | null;
    totalAmount?: number | null;
  }
): {
  status: 'matched' | 'flagged';
  vendorMatched: boolean;
  taxIdMatched: boolean;
  mathError: boolean;
  matchedCompanyId?: string;
  notes: string[];
  confidenceAdjustment: number;
} {
  const notes: string[] = [];
  let vendorMatched = false;
  let taxIdMatched = false;
  let mathError = false;
  let matchedCompanyId: string | undefined;

  // Handle null/undefined/empty values
  const safeVendorName = vendorName?.trim() || '';
  const safeVendorTaxId = vendorTaxId?.trim() || '';

  // If no vendor name, return flagged immediately
  if (!safeVendorName) {
    return {
      status: 'flagged',
      vendorMatched: false,
      taxIdMatched: false,
      mathError: false,
      matchedCompanyId: undefined,
      notes: ['Vendor name is empty or missing from invoice'],
      confidenceAdjustment: -0.5, // 50% confidence
    };
  }

  // Check for math error
  if (extractedData) {
    const mathCheck = checkMathError(
      extractedData.subtotal,
      extractedData.taxAmount,
      extractedData.totalAmount
    );
    if (mathCheck.hasError) {
      mathError = true;
      notes.push(mathCheck.message);
    }
  }

  // Check if tax ID is missing from invoice
  const taxIdMissing = !safeVendorTaxId;
  if (taxIdMissing) {
    notes.push('Tax ID is missing from invoice');
  }

  // Try to find company by tax ID first (more reliable)
  if (safeVendorTaxId) {
    const normalizedInvoiceTaxId = normalizeTaxId(safeVendorTaxId);
    const companyByTaxId = companies.find(
      (c) => normalizeTaxId(c.taxId) === normalizedInvoiceTaxId
    );

    if (companyByTaxId) {
      taxIdMatched = true;
      matchedCompanyId = companyByTaxId.id;
      notes.push(`Tax ID matched to company: ${companyByTaxId.name}`);
    } else {
      notes.push('Tax ID not found in records');
    }
  }

  // Try to find by name (fuzzy match)
  const normalizedName = safeVendorName.toLowerCase();
  const companyByName = companies.find((c) => {
    const companyNameLower = c.name.toLowerCase();
    // Check for exact match or if one contains the other
    return (
      companyNameLower === normalizedName ||
      companyNameLower.includes(normalizedName) ||
      normalizedName.includes(companyNameLower)
    );
  });

  if (companyByName) {
    vendorMatched = true;
    if (!matchedCompanyId) {
      matchedCompanyId = companyByName.id;
    }
    if (!taxIdMatched) {
      notes.push(`Vendor name matched to company: ${companyByName.name}`);
      // Check if tax IDs differ (normalized comparison)
      if (safeVendorTaxId) {
        const normalizedInvoiceTaxId = normalizeTaxId(safeVendorTaxId);
        const normalizedCompanyTaxId = normalizeTaxId(companyByName.taxId);
        if (normalizedInvoiceTaxId !== normalizedCompanyTaxId) {
          notes.push(`Tax ID mismatch. Invoice: ${safeVendorTaxId}, Record: ${companyByName.taxId}`);
        }
      }
    }
  } else {
    notes.push('Vendor name not found in company records');
  }

  // Determine status - ONLY matched if BOTH vendor AND tax ID match AND no math error
  const status: 'matched' | 'flagged' =
    vendorMatched && taxIdMatched && !mathError ? 'matched' : 'flagged';

  if (status === 'matched') {
    notes.push('Vendor fully validated');
  }

  // Calculate confidence adjustment based on specific conditions
  let confidenceAdjustment = 0;

  if (status === 'matched') {
    // Fully validated - keep 100% confidence (no adjustment needed)
    confidenceAdjustment = 0;
  } else {
    // Flagged - calculate confidence based on what matched
    if (vendorMatched && taxIdMissing) {
      // Vendor matched but tax ID is missing from invoice - still pretty confident
      confidenceAdjustment = -0.15; // 85% confidence
    } else if (vendorMatched && !taxIdMatched && !taxIdMissing) {
      // Vendor matched but tax ID doesn't match records - less confident
      confidenceAdjustment = -0.25; // 75% confidence
    } else if (!vendorMatched && taxIdMatched) {
      // Vendor not found but tax ID matched - fairly confident (tax ID is reliable)
      confidenceAdjustment = -0.20; // 80% confidence
    } else if (!vendorMatched && !taxIdMatched) {
      // Neither vendor nor tax ID found in records - LOW confidence
      // This applies whether tax ID is missing or present but not found
      confidenceAdjustment = -0.50; // 50% confidence
    } else {
      // Fallback for any other flagged cases
      confidenceAdjustment = -0.30; // 70% confidence
    }

    // Additional penalty for math error
    if (mathError) {
      confidenceAdjustment -= 0.10; // Additional 10% penalty
    }
  }

  return {
    status,
    vendorMatched,
    taxIdMatched,
    mathError,
    matchedCompanyId,
    notes,
    confidenceAdjustment,
  };
}
