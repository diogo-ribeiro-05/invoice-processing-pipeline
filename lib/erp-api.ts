import type { Company, ProcessedInvoice, DeleteResponse } from './types';

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
  extractedData: Record<string, unknown>;
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

// Vendor validation helper
export function validateVendor(
  vendorName: string | null | undefined,
  vendorTaxId: string | null | undefined,
  companies: Company[]
): {
  status: 'matched' | 'mismatched' | 'unknown';
  vendorMatched: boolean;
  taxIdMatched: boolean;
  matchedCompanyId?: string;
  notes: string[];
} {
  const notes: string[] = [];
  let vendorMatched = false;
  let taxIdMatched = false;
  let matchedCompanyId: string | undefined;

  // Handle null/undefined/empty values
  const safeVendorName = vendorName?.trim() || '';
  const safeVendorTaxId = vendorTaxId?.trim() || '';

  // If no vendor name, return unknown immediately
  if (!safeVendorName) {
    return {
      status: 'unknown',
      vendorMatched: false,
      taxIdMatched: false,
      matchedCompanyId: undefined,
      notes: ['Vendor name is empty or missing from invoice'],
    };
  }

  // Try to find company by tax ID first (more reliable)
  if (safeVendorTaxId) {
    const companyByTaxId = companies.find(
      (c) => c.taxId.toLowerCase() === safeVendorTaxId.toLowerCase()
    );

    if (companyByTaxId) {
      taxIdMatched = true;
      matchedCompanyId = companyByTaxId.id;
      notes.push(`Tax ID matched to company: ${companyByTaxId.name}`);
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
      // Check if tax IDs differ
      if (safeVendorTaxId && companyByName.taxId.toLowerCase() !== safeVendorTaxId.toLowerCase()) {
        notes.push(`Warning: Tax ID mismatch. Invoice: ${safeVendorTaxId}, Record: ${companyByName.taxId}`);
      }
    }
  }

  // Determine status
  let status: 'matched' | 'mismatched' | 'unknown';
  if (vendorMatched && taxIdMatched) {
    status = 'matched';
    notes.push('Vendor fully validated');
  } else if (vendorMatched || taxIdMatched) {
    status = 'mismatched';
    if (!vendorMatched) notes.push('Vendor name not found in records');
    if (!taxIdMatched) notes.push('Tax ID not found in records');
  } else {
    status = 'unknown';
    notes.push('Vendor not found in company records');
  }

  return {
    status,
    vendorMatched,
    taxIdMatched,
    matchedCompanyId,
    notes,
  };
}
