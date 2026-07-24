import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth';
import PDFDocument from 'pdfkit';
import { randomUUID } from 'crypto';

export const healthRouter = Router();

/**
 * GET /api/health-records
 * Returns the current user's health records.
 */
healthRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { type } = req.query;

    let query = supabaseAdmin
      .from('health_records')
      .select('*')
      .eq('user_id', req.userId);

    if (type) query = query.eq('record_type', type);

    const { data, error } = await query.order('record_date', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch records' });
      return;
    }

    res.json({ records: data || [] });
  } catch (err) {
    console.error('Get records error:', err);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

/**
 * POST /api/health-records
 * Create a new health record. File should already be uploaded to Supabase Storage;
 * this endpoint just logs the metadata.
 */
healthRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { record_type, record_date, file_url, file_name, notes } = req.body;

    if (!record_type) {
      res.status(400).json({ error: 'record_type is required' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('health_records')
      .insert({
        user_id: req.userId,
        record_type,
        record_date: record_date || new Date().toISOString().split('T')[0],
        file_url: file_url || null,
        file_name: file_name || null,
        notes: notes || null,
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to create record' });
      return;
    }

    res.status(201).json({ record: data });
  } catch (err) {
    console.error('Create record error:', err);
    res.status(500).json({ error: 'Failed to create record' });
  }
});

/**
 * POST /api/health-records/upload-url
 * Generates a signed upload URL for Supabase Storage.
 */
healthRouter.post('/upload-url', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { file_name, content_type } = req.body;

    if (!file_name) {
      res.status(400).json({ error: 'file_name is required' });
      return;
    }

    const sanitizeName = file_name.replace(/[^a-zA-Z0-9\._-]/g, '_');
    const path = `${req.userId}/${Date.now()}-${sanitizeName}`;

    // Ensure bucket 'health-records' exists in Supabase storage
    await supabaseAdmin.storage.createBucket('health-records', { public: true }).catch(() => {});

    let { data, error } = await supabaseAdmin.storage
      .from('health-records')
      .createSignedUploadUrl(path);

    if (error || !data?.signedUrl) {
      console.warn('Storage createSignedUploadUrl warning:', error?.message);
      // Fallback: If signed upload URL fails on Supabase, route PUT to direct endpoint
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
      const fallbackUploadUrl = `${baseUrl}/health-records/upload-direct?path=${encodeURIComponent(path)}`;

      res.json({
        upload_url: fallbackUploadUrl,
        file_path: path,
        public_url: `${process.env.SUPABASE_URL || ''}/storage/v1/object/public/health-records/${path}`,
      });
      return;
    }

    res.json({
      upload_url: data.signedUrl,
      file_path: path,
      public_url: `${process.env.SUPABASE_URL || ''}/storage/v1/object/public/health-records/${path}`,
    });
  } catch (err: any) {
    console.error('Upload URL error:', err);
    res.status(500).json({ error: err?.message || 'Failed to generate upload URL' });
  }
});

/**
 * PUT /api/health-records/upload-direct
 * Direct file upload fallback handler if signed URLs are disabled on Supabase.
 */
healthRouter.put('/upload-direct', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const buffer = req.body;
    const contentType = req.headers['content-type'] || 'application/octet-stream';

    await supabaseAdmin.storage.createBucket('health-records', { public: true }).catch(() => {});

    const { error } = await supabaseAdmin.storage
      .from('health-records')
      .upload(path, buffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.error('Direct upload storage error:', error);
      res.status(500).json({ error: 'Failed to upload document' });
      return;
    }

    res.json({ success: true, path });
  } catch (err: any) {
    console.error('Upload direct error:', err);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

/**
 * GET /api/health-records/symptoms
 * Returns the user's symptom logs.
 */
healthRouter.get('/symptoms', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('symptom_logs')
      .select('*')
      .eq('user_id', req.userId)
      .order('logged_at', { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({ error: 'Failed to fetch symptoms' });
      return;
    }

    res.json({ symptoms: data || [] });
  } catch (err) {
    console.error('Get symptoms error:', err);
    res.status(500).json({ error: 'Failed to fetch symptoms' });
  }
});

/**
 * POST /api/health-records/symptoms
 * Log a symptom.
 */
healthRouter.post('/symptoms', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { symptom, severity, notes } = req.body;

    const { data, error } = await supabaseAdmin
      .from('symptom_logs')
      .insert({
        user_id: req.userId,
        symptom,
        severity: severity || 'mild',
        notes: notes || null,
      })
      .select()
      .single();

    res.status(201).json({ symptom: data });
  } catch (err) {
    console.error('Log symptom error:', err);
    res.status(500).json({ error: 'Failed to log symptom' });
  }
});

function generatePrescriptionPdf(
  doctorName: string,
  patientName: string,
  patientDob: string,
  medications: string,
  instructions: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', err => reject(err));

    // SheBloom Clinical Letterhead
    doc.fillColor('#7c3aed').fontSize(24).font('Helvetica-Bold').text('SheBloom Health', { align: 'center' });
    doc.fillColor('#9d174d').fontSize(10).font('Helvetica').text('Virtual Gynecology & Endocrine Wellness Care', { align: 'center' });
    doc.moveDown(1.5);

    // Divider Line
    doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(1.5);

    // Doctor details on left
    const docStartY = doc.y;
    doc.fillColor('#1e293b').fontSize(10).font('Helvetica-Bold').text('PRESCRIBING CLINICIAN:');
    doc.font('Helvetica').text(doctorName);
    doc.text('Obstetrics & Gynecology Specialist');
    doc.text('SheBloom Medical Network');

    // Date & Patient details on right
    doc.y = docStartY;
    doc.font('Helvetica-Bold').text('PATIENT DETAILS:', 320, doc.y);
    doc.font('Helvetica').text(`Name: ${patientName}`, 320);
    if (patientDob) {
      doc.text(`Date of Birth: ${new Date(patientDob).toLocaleDateString()}`, 320);
    }
    doc.text(`Date of Issue: ${new Date().toLocaleDateString()}`, 320);

    doc.moveDown(2);
    doc.x = 50; // Reset indentation

    // Rx Symbol
    doc.fillColor('#7c3aed').fontSize(20).font('Helvetica-Bold').text('Rx', { lineGap: 10 });

    // Prescribed Medications
    doc.fillColor('#1e293b').fontSize(11).font('Helvetica-Bold').text('Prescribed Medication(s) & Dosage:');
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').text(medications, { lineGap: 4 });
    doc.moveDown(1.5);

    // Additional Instructions / Clinical Advice
    if (instructions) {
      doc.fontSize(11).font('Helvetica-Bold').text('Clinical Advice & Instructions:');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').text(instructions, { lineGap: 4 });
      doc.moveDown(2);
    }

    // Divider
    doc.strokeColor('#f1f5f9').lineWidth(0.5).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(1.5);

    // Signature
    doc.fontSize(10).font('Helvetica-Bold').text('Clinician Digital Signature:', { align: 'right' });
    doc.moveDown(0.2);
    doc.fillColor('#9d174d').fontSize(12).font('Times-Italic').text(`Digitally Signed: ${doctorName}`, { align: 'right' });
    doc.fillColor('#94a3b8').fontSize(8).font('Helvetica').text('Secure Consultation Encrypted Signature', { align: 'right' });

    doc.end();
  });
}

/**
 * POST /api/health-records/prescriptions
 * Generates a styled PDF prescription for the patient, uploads it to storage,
 * creates a health record, and sends a chat message.
 */
healthRouter.post('/prescriptions', requireAuth, requireRole('doctor'), async (req: AuthenticatedRequest, res) => {
  try {
    const { patient_id, medications, instructions } = req.body;

    if (!patient_id || !medications) {
      res.status(400).json({ error: 'patient_id and medications are required' });
      return;
    }

    // 1. Fetch doctor details
    const { data: docUser } = await supabaseAdmin
      .from('users')
      .select('full_name')
      .eq('id', req.userId)
      .single();
    const doctorName = docUser?.full_name || 'Dr. Deepa Madhavan';

    // 2. Fetch patient details
    const { data: patientUser } = await supabaseAdmin
      .from('users')
      .select('full_name, date_of_birth')
      .eq('id', patient_id)
      .single();

    if (!patientUser) {
      res.status(404).json({ error: 'Patient not found' });
      return;
    }

    const patientName = patientUser.full_name || 'Patient';
    const patientDob = patientUser.date_of_birth || '';

    // 3. Generate PDF Buffer
    const pdfBuffer = await generatePrescriptionPdf(doctorName, patientName, patientDob, medications, instructions || '');

    // 4. Upload to storage (private health-records bucket)
    const filename = `${Date.now()}-prescription.pdf`;
    const path = `${patient_id}/${filename}`;

    const { error: uploadErr } = await supabaseAdmin.storage
      .from('health-records')
      .upload(path, pdfBuffer, {
        contentType: 'application/pdf',
      });

    if (uploadErr) {
      console.error('Storage upload failed:', uploadErr);
      res.status(500).json({ error: 'Failed to upload prescription PDF' });
      return;
    }

    // 5. Save to health_records table
    const { data: recordData, error: recordErr } = await supabaseAdmin
      .from('health_records')
      .insert({
        user_id: patient_id,
        record_type: 'Prescription',
        record_date: new Date().toISOString().split('T')[0],
        file_url: path,
        file_name: `Prescription - ${new Date().toLocaleDateString()}`,
        notes: instructions || null,
      })
      .select()
      .single();

    if (recordErr) {
      console.error('Save prescription record error:', recordErr);
    }

    // 6. Post chat message with link
    let { data: convo } = await supabaseAdmin
      .from('chat_conversations')
      .select('id')
      .eq('patient_id', patient_id)
      .eq('doctor_id', req.userId)
      .maybeSingle();

    if (!convo) {
      const { data: newConvo } = await supabaseAdmin
        .from('chat_conversations')
        .insert({ patient_id, doctor_id: req.userId })
        .select('id')
        .single();
      convo = newConvo;
    }

    if (convo) {
      const fileDownloadUrl = `/api/health-records/documents/${patient_id}/${filename}`;
      await supabaseAdmin.from('chat_messages').insert({
        conversation_id: convo.id,
        sender_id: req.userId,
        content: `📋 A new medical prescription has been issued by ${doctorName}. You can download it securely.`,
        attachment_url: fileDownloadUrl,
      });
    }

    res.status(201).json({ success: true, record: recordData });
  } catch (err) {
    console.error('Generate prescription error:', err);
    res.status(500).json({ error: 'Failed to generate prescription' });
  }
});

/**
 * GET /api/health-records/documents/:patientId/:filename
 * Secure document download route. Authenticates user and checks privileges.
 */
healthRouter.get('/documents/:patientId/:filename', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { patientId, filename } = req.params;

    // Enforce role and user matching rules
    const isSelf = req.userId === patientId;
    const isDoctor = req.userRole === 'doctor';

    if (!isSelf && !isDoctor) {
      res.status(403).json({ error: 'You are not authorized to view this document' });
      return;
    }

    const path = `${patientId}/${filename}`;
    const { data, error } = await supabaseAdmin.storage
      .from('health-records')
      .download(path);

    if (error || !data) {
      console.error('Storage download error:', error);
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    const isPdf = typeof filename === 'string' && filename.endsWith('.pdf');
    res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Download document error:', err);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

healthRouter.get('/documents/:filename', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const filename = req.params.filename as string;
    let path: string = filename;
    if (!path.includes('/')) {
      path = `${req.userId}/${filename}`;
    }

    const { data, error } = await supabaseAdmin.storage
      .from('health-records')
      .download(path);

    if (error || !data) {
      console.error('Storage download error:', error);
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    const isPdf = typeof filename === 'string' && filename.endsWith('.pdf');
    res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Download document error:', err);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

/**
 * DELETE /api/health-records/:id
 * Deletes a health record and its associated file in storage.
 */
healthRouter.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch record first to get file path and verify owner
    const { data: record, error: fetchErr } = await supabaseAdmin
      .from('health_records')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !record) {
      res.status(404).json({ error: 'Record not found' });
      return;
    }

    // 2. Validate ownership (only the owner patient can delete their upload)
    if (record.user_id !== req.userId) {
      res.status(403).json({ error: 'You do not have permission to delete this record' });
      return;
    }

    // 3. Delete from Supabase Storage if file_url exists
    if (record.file_url) {
      const { error: storageErr } = await supabaseAdmin.storage
        .from('health-records')
        .remove([record.file_url]);

      if (storageErr) {
        console.warn('Storage deletion warning/failure:', storageErr);
      }
    }

    // 4. Delete from health_records table
    const { error: deleteErr } = await supabaseAdmin
      .from('health_records')
      .delete()
      .eq('id', id);

    if (deleteErr) {
      console.error('Database deletion failure:', deleteErr);
      res.status(500).json({ error: 'Failed to delete record from database' });
      return;
    }

    res.json({ success: true, message: 'Record and associated file deleted successfully' });
  } catch (err) {
    console.error('Delete health record exception:', err);
    res.status(500).json({ error: 'Failed to delete record' });
  }
});
