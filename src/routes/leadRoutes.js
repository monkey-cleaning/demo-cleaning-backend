import { Router } from 'express';
import { createLead } from '../controllers/leadController.js';
import { sendLeadToZoho } from '../services/zohoService.js';
import { sendLeadNotificationEmail } from '../services/leadNotificationService.js';
import { sendClientEmail } from '../services/clientQuoteEmailService.js';
import { supabase } from '../services/supabaseService.js';

const router = Router();

// POST /api/leads
router.post('/', createLead);

// Ruta para el formulario de contacto
router.post('/contact', async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      address,
      howDidYouHear,
      additionalMessage,
      source = 'Website Contact Form'
    } = req.body;

    if (!fullName || !email || !phone) {
      return res.status(400).json({ 
        error: 'Full name, email and phone are required' 
      });
    }

    const leadData = {
      fullName,
      email,
      phone,
      address: address || '',
      additionalMessage: `How did you hear about us: ${howDidYouHear}. Message: ${additionalMessage}`,
      source,
      status: 'pending'
    };

    // Guardar en Supabase
    let savedLead = null;
    let dbError = null;

    try {
      savedLead = await saveLeadToDatabase(leadData);
    } catch (err) {
      dbError = err;
      console.error('Error saving contact lead to DB:', err);
    }

    // Enviar a Zoho
    let zohoResult = null;
    let zohoError = null;
    try {
      zohoResult = await sendLeadToZoho(leadData);
    } catch (err) {
      zohoError = err;
      console.error('Error sending contact lead to Zoho:', err);
    }

    // Enviar SIEMPRE email con el resumen al equipo interno
    try {
      await sendLeadNotificationEmail(leadData, {
        operation: 'created',
        zohoResult,
        zohoError,
        dbLead: savedLead,
        dbError,
        source,
      });
    } catch (notifyErr) {
      console.error('Error sending lead notification email (contact):', notifyErr.message);
    }

    // Enviar email de confirmación al cliente (solo si tenemos email válido)
    if (email) {
      try {
        const { subject, html } = buildCustomerConfirmationEmail({ fullName });
        await sendClientEmail({ to: email, subject, html });
        console.log(`📨 Confirmation email sent to ${email} (contact form)`);
      } catch (clientMailErr) {
        console.error('❌ Error sending contact confirmation email to client:', clientMailErr.message);
      }
    }

    if (dbError) {
      return res.status(500).json({ 
        error: 'Failed to save contact form in database',
        details: process.env.NODE_ENV === 'development' ? dbError.message : undefined
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Contact form submitted successfully',
      lead: savedLead,
      zohoId: zohoResult?.id || null
    });
    
  } catch (error) {
    console.error('Error processing contact form:', error);
    res.status(500).json({ 
      error: 'Failed to process contact form',
      details: error.message 
    });
  }
});

// GET /api/leads/:id — returns only the fields needed to pre-fill the booking modal
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('leads')
      .select('id, full_name, email, phone, address')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    return res.json({
      id:       data.id,
      fullName: data.full_name,
      email:    data.email,
      phone:    data.phone    || '',
      address:  data.address  || '',
    });
  } catch (err) {
    console.error('❌ GET /api/leads/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads?search=nombre&limit=10
router.get('/', async (req, res) => {
  try {
    const { search, limit = 10 } = req.query;

    let query = supabase
      .from('leads')
      .select('id, full_name, email, phone')
      .order('created_at', { ascending: false })
      .limit(Number(limit));

    if (search) {
      query = query.or(
        `full_name.ilike.%${search}%,email.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ data });
  } catch (err) {
    console.error('❌ GET /api/leads:', err.message);
    res.status(500).json({ error: err.message });
  }
});  

export default router;