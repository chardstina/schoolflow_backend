/**
 * PDF Report Card Generator — PDFKit
 *
 * Generates a Nigerian-school-style report card with:
 *  - School header, logo, term/session info
 *  - Student bio section
 *  - Subject scores table (CA1 | CA2 | Exam | Total | Grade | Position | Remark)
 *  - Attendance summary
 *  - Overall average & class teacher comment area
 *  - Principal signature block
 */

import PDFDocument from 'pdfkit';
import path from 'path';

interface ReportCardData {
  student: any;
  term: any;
  results: any[];
  attendanceSummary: any[];
  totalScore: number;
  average: number;
}

export async function generateReportCardPdf(data: ReportCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { student, term, results, attendanceSummary, average } = data;
    const school = student.school;

    const BLUE = '#1a3c5e';
    const LIGHT = '#e8f0fe';
    const W = 515; // usable page width

    // ── Header ────────────────────────────────────────────────
    doc.rect(40, 40, W, 80).fill(BLUE);
    doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
      .text(school.name.toUpperCase(), 50, 55, { width: W - 20, align: 'center' });
    doc.fontSize(10).font('Helvetica')
      .text(school.address ?? '', 50, 78, { width: W - 20, align: 'center' })
      .text(`Tel: ${school.phone ?? ''} | Email: ${school.email ?? ''}`, 50, 92, {
        width: W - 20, align: 'center',
      });

    doc.moveDown(0.5);
    doc.fillColor(BLUE).fontSize(14).font('Helvetica-Bold')
      .text('STUDENT REPORT CARD', 40, 130, { width: W, align: 'center' });

    // ── Student bio ───────────────────────────────────────────
    const bioY = 155;
    doc.rect(40, bioY, W, 55).fill(LIGHT);
    doc.fillColor('#333').fontSize(9).font('Helvetica');

    const col1 = 48, col2 = 210, col3 = 390;
    doc.text(`Student Name:`, col1, bioY + 8).font('Helvetica-Bold')
      .text(`${student.firstName} ${student.lastName}`.toUpperCase(), col1 + 85, bioY + 8);
    doc.font('Helvetica').text(`Admission No:`, col1, bioY + 22)
      .font('Helvetica-Bold').text(student.admissionNo, col1 + 85, bioY + 22);
    doc.font('Helvetica').text(`Class:`, col1, bioY + 36)
      .font('Helvetica-Bold').text(student.class?.name ?? '', col1 + 85, bioY + 36);

    doc.font('Helvetica').text(`Term:`, col2, bioY + 8)
      .font('Helvetica-Bold').text(term?.name ?? '', col2 + 50, bioY + 8);
    doc.font('Helvetica').text(`Session:`, col2, bioY + 22)
      .font('Helvetica-Bold').text(term?.session?.name ?? '', col2 + 55, bioY + 22);

    doc.font('Helvetica').text(`Average:`, col3, bioY + 8)
      .font('Helvetica-Bold').text(`${average.toFixed(1)}%`, col3 + 55, bioY + 8);

    // ── Scores table ─────────────────────────────────────────
    const tableTop = bioY + 65;
    const cols = {
      subject: { x: 40, w: 130 },
      ca1:     { x: 170, w: 45 },
      ca2:     { x: 215, w: 45 },
      exam:    { x: 260, w: 50 },
      total:   { x: 310, w: 50 },
      grade:   { x: 360, w: 40 },
      pos:     { x: 400, w: 35 },
      remark:  { x: 435, w: 120 },
    };

    // Header row
    doc.rect(40, tableTop, W, 18).fill(BLUE);
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
    const headers = ['SUBJECT', 'CA1/20', 'CA2/20', 'EXAM/60', 'TOTAL', 'GRADE', 'POS', 'REMARK'];
    const colKeys = Object.keys(cols) as (keyof typeof cols)[];
    headers.forEach((h, i) => {
      const c = cols[colKeys[i]];
      doc.text(h, c.x + 2, tableTop + 5, { width: c.w, align: 'center' });
    });

    let rowY = tableTop + 18;
    results.forEach((r, idx) => {
      const bg = idx % 2 === 0 ? 'white' : '#f7faff';
      doc.rect(40, rowY, W, 16).fill(bg);
      doc.fillColor('#222').fontSize(8).font('Helvetica');

      const row = [
        r.subject?.name ?? '',
        r.caScore1 != null ? String(r.caScore1) : '—',
        r.caScore2 != null ? String(r.caScore2) : '—',
        r.examScore != null ? String(r.examScore) : '—',
        r.totalScore != null ? String(r.totalScore) : '—',
        r.grade ?? '—',
        r.position != null ? String(r.position) : '—',
        r.remark ?? '',
      ];

      row.forEach((cell, i) => {
        const c = cols[colKeys[i]];
        doc.text(cell, c.x + 2, rowY + 4, { width: c.w, align: 'center' });
      });

      rowY += 16;
    });

    // Table border
    doc.rect(40, tableTop, W, rowY - tableTop).stroke(BLUE);

    // ── Attendance ────────────────────────────────────────────
    const attY = rowY + 14;
    doc.fillColor(BLUE).fontSize(10).font('Helvetica-Bold').text('ATTENDANCE SUMMARY', 40, attY);
    doc.rect(40, attY + 14, 250, 30).fill(LIGHT);
    doc.fillColor('#333').fontSize(9).font('Helvetica');

    const attMap: Record<string, number> = {};
    (attendanceSummary ?? []).forEach((a: any) => { attMap[a.status] = a._count; });
    doc.text(
      `Present: ${attMap.PRESENT ?? 0}   |   Absent: ${attMap.ABSENT ?? 0}   |   Late: ${attMap.LATE ?? 0}   |   Excused: ${attMap.EXCUSED ?? 0}`,
      48, attY + 22, { width: 230 }
    );

    // ── Comment & Signature ───────────────────────────────────
    const commentY = attY + 54;
    doc.fillColor(BLUE).fontSize(10).font('Helvetica-Bold').text('Class Teacher\'s Comment:', 40, commentY);
    doc.rect(40, commentY + 14, W, 36).stroke(BLUE);

    const sigY = commentY + 62;
    doc.fontSize(9).font('Helvetica')
      .text("Class Teacher's Signature: _______________________", 40, sigY)
      .text("Principal's Signature: _______________________", 310, sigY);

    // ── Footer ────────────────────────────────────────────────
    doc.fontSize(7).fillColor('#999')
      .text(
        `Generated by SchoolFlow • ${new Date().toLocaleDateString('en-NG')}`,
        40, doc.page.height - 40, { width: W, align: 'center' }
      );

    doc.end();
  });
}

// ── Fee Receipt PDF ────────────────────────────────────────────

export async function generateReceiptPdf(payment: any, invoice: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 40, size: 'A5' });

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const BLUE = '#1a3c5e';
    const W = 395;

    doc.rect(40, 40, W, 60).fill(BLUE);
    doc.fillColor('white').fontSize(16).font('Helvetica-Bold')
      .text(invoice.school?.name ?? 'School', 50, 52, { width: W - 20, align: 'center' });
    doc.fontSize(9).font('Helvetica')
      .text('OFFICIAL FEE RECEIPT', 50, 74, { width: W - 20, align: 'center' });

    const receiptY = 115;
    const fmt = (n: number) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(n / 100);

    doc.fillColor('#333').fontSize(9).font('Helvetica');
    const rows = [
      ['Receipt No', payment.id.slice(-8).toUpperCase()],
      ['Invoice No', invoice.invoiceNo],
      ['Student', `${invoice.student?.firstName} ${invoice.student?.lastName}`],
      ['Class', invoice.student?.class?.name ?? ''],
      ['Term', invoice.term?.name ?? ''],
      ['Amount Paid', fmt(payment.amountKobo)],
      ['Balance', fmt(invoice.balanceKobo)],
      ['Channel', payment.channel.replace(/_/g, ' ')],
      ['Date', new Date(payment.paidAt).toLocaleDateString('en-NG')],
    ];

    rows.forEach(([label, value], i) => {
      const y = receiptY + i * 20;
      doc.rect(40, y, W, 20).fill(i % 2 === 0 ? '#f5f5f5' : 'white');
      doc.fillColor('#555').text(label, 48, y + 6, { width: 130 });
      doc.fillColor('#111').font('Helvetica-Bold').text(value, 180, y + 6, { width: 250 });
      doc.font('Helvetica');
    });

    const stampY = receiptY + rows.length * 20 + 20;
    doc.fillColor('#aaa').fontSize(28).font('Helvetica-Bold')
      .opacity(0.15).text('PAID', 40, stampY, { width: W, align: 'center' }).opacity(1);

    doc.fillColor('#666').fontSize(7)
      .text(`Generated by SchoolFlow • ${new Date().toLocaleDateString('en-NG')}`,
        40, doc.page.height - 30, { width: W, align: 'center' });

    doc.end();
  });
}
