import { NextRequest, NextResponse } from 'next/server';
import {
  getProcessedInvoices,
  submitProcessedInvoice,
  deleteAllProcessedInvoices,
} from '@/lib/erp-api';

export async function GET() {
  try {
    const result = await getProcessedInvoices();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching processed invoices:', error);
    return NextResponse.json(
      { error: 'Failed to fetch processed invoices' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await submitProcessedInvoice(body);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error submitting invoice:', error);
    return NextResponse.json(
      { error: 'Failed to submit invoice' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const result = await deleteAllProcessedInvoices();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error deleting invoices:', error);
    return NextResponse.json(
      { error: 'Failed to delete invoices' },
      { status: 500 }
    );
  }
}
