// ══════════════════════════════════════════════════════════
// send-notification Edge Function
// ══════════════════════════════════════════════════════════
//
// Central notification dispatcher for HavenPlus.
// Inserts in-app notification (notifications table) + sends email via Resend.
//
// Called from:
//   - profile.html saveSchedEdit()    → type: 'scheduled' (cleaning confirmed)
//   - haventeam.html confirmComplete() → type: 'completed' (job done)
//   - daily-reminder Edge Function     → type: 'reminder'  (day-before)
//   - stripe-webhook                   → type: 'payment_received' (new payment)
//   - profile.html new cleaning/SR     → type: 'new_request' (admin alert)
//
// Admin notifications use direct_emails array (no DB lookup needed).
// Admin emails: hi@havenpluscare.com, jinhyunmail@gmail.com
//
// ══════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SB_SERVICE_ROLE_KEY')!
)

const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || ''

const ADMIN_EMAILS = ['hi@havenpluscare.com', 'jinhyunmail@gmail.com']
const ADMIN_URL_CLEANINGS = 'https://havenpluscare.com/profile.html#cleanings'
const ADMIN_URL_JOBS = 'https://havenpluscare.com/profile.html#jobrequests'
const ADMIN_URL_PAYMENTS = 'https://havenpluscare.com/profile.html#payments'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Resolve email address from user ID ──
async function resolveEmail(userId: string, recipientType: string): Promise<string | null> {
  if (recipientType === 'worker') {
    const { data } = await supabase
      .from('workers')
      .select('email')
      .eq('id', userId)
      .maybeSingle()
    return data?.email || null
  }
  // profiles 테이블에 email 컬럼 없음 — auth.users에서 직접 조회
  try {
    const { data: { user } } = await supabase.auth.admin.getUserById(userId)
    return user?.email || null
  } catch(e) {
    console.error('resolveEmail auth.users error:', e)
    return null
  }
}

// ── Send email via Resend (single recipient) ──
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email')
    return false
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: 'Haven Plus <noreply@havenpluscare.com>',
        to: [to],
        subject,
        html,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('Resend error:', err)
      return false
    }
    return true
  } catch (e) {
    console.error('Email send failed:', e)
    return false
  }
}

// ── Email wrapper template ──
function wrapTemplate(body: string): string {
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#0f2b46 0%,#1a3a5c 100%);padding:28px 32px;">
      <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:.5px;">HAVEN<span style="color:#ff6b35;">PLUS</span></div>
      <div style="font-size:11px;color:rgba(255,255,255,.7);margin-top:2px;letter-spacing:.3px;">PROPERTY CARE</div>
    </div>
    <div style="padding:32px;">${body}</div>
    <div style="background:#f8f9fa;padding:20px 32px;text-align:center;border-top:1px solid #e5e7eb;">
      <a href="https://havenpluscare.com" style="color:#ff6b35;font-size:13px;text-decoration:none;font-weight:600;">havenpluscare.com</a>
      <div style="font-size:11px;color:#9ca3af;margin-top:6px;">© 2026 Haven Plus Property Care</div>
    </div>
  </div>`
}

function adminButton(label: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#ff6b35;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">${label} →</a>`
}

// ── Build email content by type ──
function buildEmail(
  type: string,
  recipientType: string,
  details: {
    address?: string
    date?: string
    time?: string
    amount?: number
    plan?: string
    customer_name?: string
    customer_email?: string
    payment_id?: string
    paid_at?: string
    category?: string
    original_date?: string
    note?: string
    worker_name?: string
    is_same_day?: boolean
    reschedule_count?: number
    auto_approved?: boolean
  },
  refType: string = 'cleaning'
): { subject: string; html: string } {

  const addr = details.address || 'your property'
  const date = details.date || ''
  const time = details.time || ''
  const dateStr = date && time ? `${date} at ${time}` : date || 'the scheduled date'
  const isService = refType === 'service'
  const jobLabel = isService ? 'Service' : 'Cleaning'
  const isAdmin = recipientType === 'admin'

  switch (type) {

    // ── New Payment ──
    case 'subscription_confirmed': {
      const plan = (details.plan || '').toLowerCase()
      const planLabel: Record<string, string> = {
        essential: 'Essential Care',
        smart: 'Smart Care',
        premium: 'Premium Care',
      }
      const planName = planLabel[plan] || plan
      const cleaningLabel: Record<string, string> = {
        essential: '8 hours (4 cleans/year)',
        smart: '12 hours (6 cleans/year)',
        premium: '24 hours (12 cleans/year)',
      }
      const shLabel: Record<string, string> = {
        essential: '2 SH vouchers/year',
        smart: '3 SH vouchers/year',
        premium: '6 SH vouchers/year',
      }
      const receiptUrl = details.receipt_url || ''
      const customer = details.customer_name || ''
      // 실제 결제 금액 + billing cycle (stripe-webhook에서 전달)
      const amount = details.amount ? `$${Number(details.amount).toFixed(0)} AUD` : null
      const billingCycle = details.billing_cycle || ''
      const cycleLabel = billingCycle === 'year' ? '/year' : billingCycle === 'month' ? '/month' : ''
      const priceStr = amount ? `${amount}${cycleLabel}` : null
      return {
        subject: `Welcome to Haven Plus — ${planName} Confirmed`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
            <div style="background:#162d47;padding:28px 24px;text-align:center;">
              <img src="https://sunvita.github.io/havenplus/havenplus-logo.png" width="311" height="84" style="display:block;margin:0 auto;" alt="HAVEN PLUS PROPERTY CARE" />
            </div>
            <div style="padding:32px 24px;">
              <h2 style="margin:0 0 16px;">Your subscription is confirmed ✅</h2>
              <p style="color:#555;margin:0 0 24px;">Thank you for subscribing to Haven Plus${customer ? ', ' + customer : ''}. We're delighted to have you on board — your property is in good hands. Here's a summary of your plan:</p>
              <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
                <p style="margin:0 0 8px;"><strong>Plan:</strong> ${planName}</p>
                ${priceStr ? `<p style="margin:0 0 8px;"><strong>Price:</strong> ${priceStr}</p>` : ''}
                <p style="margin:0 0 8px;"><strong>Cleaning:</strong> ${cleaningLabel[plan.toLowerCase()] || ''}</p>
                <p style="margin:0;"><strong>Service Hour vouchers:</strong> ${shLabel[plan.toLowerCase()] || ''}</p>
              </div>
              <p style="color:#555;margin:0 0 24px;">Log in to your dashboard to manage your property details and set your preferred cleaning start month.</p>
              <table style="border-collapse:collapse;table-layout:fixed;width:200px;">
                <tr>
                  <td style="padding:0 0 12px 0;width:168px;">
                    <a href="https://havenpluscare.com/dashboard.html"
                       style="display:block;background:#1a3c5e;color:#fff;text-decoration:none;padding:12px 0;border-radius:6px;font-weight:600;border:1.5px solid #1a3c5e;box-sizing:border-box;text-align:center;width:100%;">
                      Go to Dashboard
                    </a>
                  </td>
                </tr>
                ${receiptUrl ? `
                <tr>
                  <td style="padding:0;width:168px;">
                    <a href="${receiptUrl}"
                       style="display:block;background:#fff;color:#1a3c5e;text-decoration:none;padding:12px 0;border-radius:6px;font-weight:600;border:1.5px solid #1a3c5e;box-sizing:border-box;text-align:center;width:100%;">
                      View Receipt
                    </a>
                  </td>
                </tr>` : ''}
              </table>
              <p style="color:#999;font-size:12px;margin:32px 0 0;">
                Haven Plus Care · Perth, WA · ABN 83 695 213 499<br>
                Questions? Send email to <a href="mailto:hi@havenpluscare.com" style="color:#999;">hi@havenpluscare.com</a>
              </p>
            </div>
          </div>`
      }
    }

    case 'sh_bundle_confirmed': {
      const shAmount = details.sh_amount || 0
      const customer = details.customer_name || ''
      const amountPaid = details.amount ? `$${Number(details.amount).toFixed(0)} AUD` : ''
      const receiptUrl = details.receipt_url || ''
      return {
        subject: `Haven Plus — ${shAmount} Service Hour${shAmount > 1 ? 's' : ''} Added`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
            <div style="background:#162d47;padding:28px 24px;text-align:center;">
              <img src="https://sunvita.github.io/havenplus/havenplus-logo.png" width="311" height="84" style="display:block;margin:0 auto;" alt="HAVEN PLUS PROPERTY CARE" />
            </div>
            <div style="padding:32px 24px;">
              <h2 style="margin:0 0 16px;">Service Hours added ✅</h2>
              <p style="color:#555;margin:0 0 24px;">Thank you${customer ? ', ' + customer : ''}. Your Service Hour bundle has been added to your account.</p>
              <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
                <p style="margin:0 0 8px;"><strong>Service Hours added:</strong> ${shAmount} SH</p>
                ${amountPaid ? `<p style="margin:0;"><strong>Amount paid:</strong> ${amountPaid}</p>` : ''}
              </div>
              <p style="color:#555;margin:0 0 24px;">Your SH balance has been updated in your dashboard.</p>
              <table style="border-collapse:collapse;table-layout:fixed;width:200px;">
                <tr>
                  <td style="padding:0 0 12px 0;width:168px;">
                    <a href="https://havenpluscare.com/dashboard.html"
                       style="display:block;background:#1a3c5e;color:#fff;text-decoration:none;padding:12px 0;border-radius:6px;font-weight:600;border:1.5px solid #1a3c5e;box-sizing:border-box;text-align:center;width:100%;">
                      Go to Dashboard
                    </a>
                  </td>
                </tr>
                ${receiptUrl ? `
                <tr>
                  <td style="padding:0;width:168px;">
                    <a href="${receiptUrl}"
                       style="display:block;background:#fff;color:#1a3c5e;text-decoration:none;padding:12px 0;border-radius:6px;font-weight:600;border:1.5px solid #1a3c5e;box-sizing:border-box;text-align:center;width:100%;">
                      View Receipt
                    </a>
                  </td>
                </tr>` : ''}
              </table>
              <p style="color:#999;font-size:12px;margin:32px 0 0;">
                Haven Plus Care · Perth, WA · ABN 83 695 213 499<br>
                Questions? <a href="mailto:hi@havenpluscare.com" style="color:#999;">hi@havenpluscare.com</a>
              </p>
            </div>
          </div>`
      }
    }

    case 'payment_received': {
      const amount = details.amount ? `$${details.amount.toFixed(2)} AUD` : ''
      const plan = details.plan || ''
      const customer = details.customer_name || ''
      const customerEmail = details.customer_email || ''
      const paymentId = details.payment_id || ''
      const paidAt = details.paid_at ? new Date(details.paid_at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : ''
      return {
        subject: `Haven Plus — New Payment Received${amount ? ': ' + amount : ''}${customer ? ' from ' + customer : ''}`,
        html: wrapTemplate(`
          <h2 style="margin:0 0 16px;color:#0f2b46;">New payment received 💳</h2>
          <p style="color:#555;margin:0 0 24px;">A new subscription payment has been processed successfully.</p>
          <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:8px;">
            ${customer ? `<p style="margin:0 0 8px;"><strong>Customer:</strong> ${customer}</p>` : ''}
            ${customerEmail ? `<p style="margin:0 0 8px;"><strong>Email:</strong> ${customerEmail}</p>` : ''}
            ${plan ? `<p style="margin:0 0 8px;"><strong>Plan:</strong> ${plan}</p>` : ''}
            ${amount ? `<p style="margin:0 0 8px;"><strong>Amount:</strong> <span style="color:#059669;font-weight:700;">${amount}</span></p>` : ''}
            ${paidAt ? `<p style="margin:0 0 8px;"><strong>Date:</strong> ${paidAt}</p>` : ''}
            ${paymentId ? `<p style="margin:0;font-size:11px;color:#9ca3af;"><strong>Payment ID:</strong> ${paymentId}</p>` : ''}
          </div>
          ${adminButton('View Payments', ADMIN_URL_PAYMENTS)}
        `)
      }
    }

    // ── New Cleaning / Job Request ──
    case 'new_request': {
      const category = details.category || jobLabel
      const customer = details.customer_name || ''
      const adminUrl = isService ? ADMIN_URL_JOBS : ADMIN_URL_CLEANINGS
      const menuLabel = isService ? 'View Job Requests' : 'View Cleanings'
      return {
        subject: `Haven Plus — New ${jobLabel} Request${customer ? ' from ' + customer : ''}`,
        html: wrapTemplate(`
          <h2 style="margin:0 0 16px;color:#0f2b46;">New ${jobLabel.toLowerCase()} request 📥</h2>
          <p style="color:#555;margin:0 0 24px;">A new ${jobLabel.toLowerCase()} request has been submitted and requires your attention.</p>
          <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:8px;">
            ${customer ? `<p style="margin:0 0 8px;"><strong>Customer:</strong> ${customer}</p>` : ''}
            <p style="margin:0 0 8px;"><strong>Type:</strong> ${category}</p>
            ${addr !== 'your property' ? `<p style="margin:0 0 8px;"><strong>Property:</strong> ${addr}</p>` : ''}
            ${dateStr !== 'the scheduled date' ? `<p style="margin:0;"><strong>Requested date:</strong> ${dateStr}</p>` : ''}
          </div>
          ${adminButton(menuLabel, adminUrl)}
        `)
      }
    }

    // ── Cleaning / Service Confirmed ──
    case 'scheduled': {
      if (recipientType === 'worker') {
        return {
          subject: `Haven Plus — New Job Assigned for ${dateStr}`,
          html: wrapTemplate(`
            <h2 style="margin:0 0 16px;">New job assigned 📋</h2>
            <p style="color:#555;margin:0 0 24px;">You have a new job assignment. Please check the Haven Team app for full details.</p>
            <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
              <p style="margin:0 0 8px;"><strong>Date:</strong> ${dateStr}</p>
              <p style="margin:0;"><strong>Address:</strong> ${addr}</p>
            </div>
            <p style="color:#555;margin:0;">Open the Haven Team app to confirm and prepare for this job.</p>
          `)
        }
      }
      return {
        subject: `Haven Plus — Your ${jobLabel} is Confirmed for ${dateStr}`,
        html: wrapTemplate(`
          <h2 style="margin:0 0 16px;">Cleaning confirmed ✅</h2>
          <p style="color:#555;margin:0 0 24px;">Great news — your cleaning has been scheduled and confirmed!</p>
          <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
            <p style="margin:0 0 8px;"><strong>Date:</strong> ${dateStr}</p>
            <p style="margin:0;"><strong>Property:</strong> ${addr}</p>
          </div>
          <p style="color:#555;margin:0;">We'll send you a reminder the day before. If you need to make any changes, please contact us.</p>
        `)
      }
    }

    // ── Reminder ──
    case 'reminder': {
      if (recipientType === 'worker') {
        return {
          subject: `Haven Plus — Reminder: Job Tomorrow at ${time || 'scheduled time'}`,
          html: wrapTemplate(`
            <h2 style="margin:0 0 16px;">Reminder: Job tomorrow ⏰</h2>
            <p style="color:#555;margin:0 0 24px;">Just a reminder — you have a job scheduled for tomorrow.</p>
            <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
              <p style="margin:0 0 8px;"><strong>Time:</strong> ${time || 'See app for details'}</p>
              <p style="margin:0;"><strong>Address:</strong> ${addr}</p>
            </div>
            <p style="color:#555;margin:0;">Please check the Haven Team app for full details and confirm your availability.</p>
          `)
        }
      }
      return {
        subject: `Haven Plus — Reminder: Cleaning Tomorrow at ${time || 'scheduled time'}`,
        html: wrapTemplate(`
          <h2 style="margin:0 0 16px;">Reminder: Cleaning tomorrow ⏰</h2>
          <p style="color:#555;margin:0 0 24px;">Just a friendly reminder — your cleaning is scheduled for tomorrow.</p>
          <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
            <p style="margin:0 0 8px;"><strong>Time:</strong> ${time || 'See dashboard for details'}</p>
            <p style="margin:0;"><strong>Property:</strong> ${addr}</p>
          </div>
          <p style="color:#555;margin:0;">If you need to make any changes, please contact us as soon as possible.</p>
        `)
      }
    }

    // ── Completed ──
    case 'completed': {
      return {
        subject: `Haven Plus — Your ${jobLabel} is Complete!`,
        html: wrapTemplate(`
          <h2 style="margin:0 0 16px;">${jobLabel} complete 🎉</h2>
          <p style="color:#555;margin:0 0 24px;">Your property ${isService ? 'service has been completed' : 'has been cleaned and is looking great'}! You can view before &amp; after photos in your dashboard.</p>
          <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
            <p style="margin:0;"><strong>Property:</strong> ${addr}</p>
          </div>
          <p style="color:#555;margin:0;">We'd love to hear your feedback — it helps us keep improving our service.</p>
        `)
      }
    }

    // ── Reschedule Confirmed (customer) ──
    case 'reschedule_confirmed': {
      const newDate = details.date || 'the new date'
      return {
        subject: `Haven Plus — Your ${jobLabel} Has Been Rescheduled`,
        html: wrapTemplate(`
          <h2 style="margin:0 0 16px;color:#0f2b46;">Your ${jobLabel.toLowerCase()} has been rescheduled ✅</h2>
          <p style="color:#555;margin:0 0 24px;">Your reschedule request has been approved. Here are your updated details:</p>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px 24px;margin-bottom:24px;">
            <p style="margin:0 0 8px;"><strong>Property:</strong> ${addr}</p>
            <p style="margin:0;"><strong>New Date:</strong> <span style="color:#059669;font-weight:700;">${newDate}</span></p>
          </div>
          <p style="color:#555;margin:0;">We'll send you a reminder the day before. If you have any questions, please contact us.</p>
        `)
      }
    }

    // ── Reschedule Request ──
    case 'reschedule_request': {
      const workerName = details.worker_name || 'A worker'
      const originalDate = details.original_date || ''
      const newDate = details.date || ''
      const note = details.note || ''
      const autoApproved = details.auto_approved === true
      const isSameDay = details.is_same_day === true
      const rescheduleCount = details.reschedule_count || 1
      const adminUrl = isService ? ADMIN_URL_JOBS : ADMIN_URL_CLEANINGS
      const menuLabel = isService ? 'View Job Requests' : 'View Cleanings'
      const statusTag = autoApproved
        ? `<span style="background:#d1fae5;color:#065f46;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;">Auto-approved</span>`
        : `<span style="background:#fef9c3;color:#92400e;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;">Pending Approval</span>`
      return {
        subject: `Haven Plus — ${autoApproved ? '' : '⚠️ '}Reschedule Request${autoApproved ? ' (Auto-approved)' : ' Requires Approval'}`,
        html: wrapTemplate(`
          <h2 style="margin:0 0 16px;color:#0f2b46;">Job reschedule request 📅</h2>
          <p style="color:#555;margin:0 0 24px;">${workerName} has requested to reschedule a ${jobLabel.toLowerCase()} job. ${statusTag}</p>
          <div style="background:#f5f8fa;border-radius:8px;padding:20px 24px;margin-bottom:8px;">
            <p style="margin:0 0 8px;"><strong>Worker:</strong> ${workerName}</p>
            <p style="margin:0 0 8px;"><strong>Property:</strong> ${addr}</p>
            ${originalDate ? `<p style="margin:0 0 8px;"><strong>Original date:</strong> ${originalDate}</p>` : ''}
            ${newDate ? `<p style="margin:0 0 8px;"><strong>Proposed date:</strong> <span style="color:#059669;font-weight:700;">${newDate}</span></p>` : ''}
            ${isSameDay ? `<p style="margin:0 0 8px;color:#b45309;"><strong>⚠️ Same-day reschedule</strong></p>` : ''}
            ${rescheduleCount > 1 ? `<p style="margin:0 0 8px;color:#b45309;"><strong>Reschedule count:</strong> ${rescheduleCount}</p>` : ''}
            ${note ? `<p style="margin:0;font-size:12px;color:#555;"><strong>Note:</strong> ${note}</p>` : ''}
          </div>
          ${adminButton(menuLabel, adminUrl)}
        `)
      }
    }

    default:
      return {
        subject: 'Haven Plus — Notification',
        html: wrapTemplate(`<p style="color:#555;">You have a new notification.</p>`)
      }
  }
}

// ── Build in-app notification title ──
function buildTitle(type: string, recipientType: string, details: { date?: string; time?: string; amount?: number; customer_name?: string; worker_name?: string }, refType: string = 'cleaning'): string {
  const dateStr = details.date && details.time
    ? `${details.date} at ${details.time}`
    : details.date || ''
  const isService = refType === 'service'
  const jobLabel = isService ? 'Service' : 'Cleaning'

  switch (type) {
    case 'scheduled':
      return recipientType === 'worker'
        ? `New job assigned for ${dateStr}`
        : `${jobLabel} confirmed for ${dateStr}`
    case 'reminder':
      return `Reminder: Tomorrow at ${details.time || 'scheduled time'}`
    case 'completed':
      return `Your ${jobLabel.toLowerCase()} is complete!`
    case 'subscription_confirmed':
      return `Welcome to Haven Plus — ${details.plan || 'Plan'} Confirmed`
    case 'sh_bundle_confirmed':
      return `${details.sh_amount || ''} Service Hours added to your account`
    case 'payment_received':
      return `Payment received${details.amount ? ': $' + details.amount.toFixed(2) : ''}${details.customer_name ? ' from ' + details.customer_name : ''}`
    case 'new_request':
      return `New ${jobLabel.toLowerCase()} request${details.customer_name ? ' from ' + details.customer_name : ''}`
    case 'reschedule_confirmed':
      return `Your ${jobLabel.toLowerCase()} has been rescheduled to ${details.date || 'a new date'}`
    case 'reschedule_request':
      return `Reschedule request${details.worker_name ? ' from ' + details.worker_name : ''}${details.date ? ' → ' + details.date : ''}`
    default:
      return 'New notification'
  }
}

// ══════════════════════════════════════════════════════════
// Main handler
// ══════════════════════════════════════════════════════════
//
// Request body:
// {
//   type: 'scheduled' | 'reminder' | 'completed' | 'payment_received' | 'new_request',
//   recipients: [{ id: uuid, type: 'customer' | 'worker' }],   // DB-resolved
//   direct_emails: ['email@a.com'],                             // admin fixed emails (optional)
//   reference_id: uuid,
//   reference_type: 'cleaning' | 'service',
//   details: { address, date, time, amount, plan, customer_name, category }
// }
//
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    const {
      type,
      recipients = [],
      direct_emails = [],         // admin fixed email addresses
      notify_admins = false,      // shorthand: send to all ADMIN_EMAILS
      reference_id,
      reference_type,
      details = {},
    } = await req.json()

    if (!type) {
      return new Response(JSON.stringify({ error: 'Missing type' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Map simple type + reference_type → DB constraint value
    const dbTypeMap: Record<string, Record<string, string>> = {
      scheduled:        { cleaning: 'cleaning_scheduled', service: 'service_confirmed' },
      reminder:         { cleaning: 'cleaning_reminder',  service: 'job_reminder' },
      completed:        { cleaning: 'cleaning_completed', service: 'service_completed' },
      subscription_confirmed: { cleaning: 'payment_received', service: 'payment_received' },
      sh_bundle_confirmed: { cleaning: 'payment_received', service: 'payment_received' },
      payment_received: { cleaning: 'payment_received',   service: 'payment_received' },
      new_request:         { cleaning: 'cleaning_scheduled', service: 'service_confirmed' },
      reschedule_confirmed: { cleaning: 'cleaning_scheduled', service: 'service_confirmed' },
      reschedule_request:   { cleaning: 'cleaning_scheduled', service: 'service_confirmed' },
    }
    const refType = reference_type || 'cleaning'
    const dbType = dbTypeMap[type]?.[refType] || type

    const results: Array<{ recipient: string; notification: boolean; email: boolean }> = []

    // 1. DB-resolved recipients (customers / workers)
    for (const recipient of recipients) {
      const title = buildTitle(type, recipient.type, details, refType)
      const message = details?.address ? `${title} — ${details.address}` : title

      const { data: inserted, error: insertErr } = await supabase
        .from('notifications')
        .insert({
          user_id:        recipient.id,
          type:           dbType,
          title,
          message,
          channel:        'email',
          is_read:        false,
          sent_at:        null,
          recipient_type: recipient.type,
          reference_id:   reference_id || null,
          reference_type: reference_type || null,
        })
        .select('id')
        .single()

      if (insertErr) {
        console.error(`Notification insert error for ${recipient.id}:`, insertErr)
        results.push({ recipient: recipient.id, notification: false, email: false })
        continue
      }

      let emailSent = false
      const email = await resolveEmail(recipient.id, recipient.type)
      if (email) {
        const { subject, html } = buildEmail(type, recipient.type, details, refType)
        emailSent = await sendEmail(email, subject, html)
        if (emailSent && inserted?.id) {
          await supabase.from('notifications').update({ sent_at: new Date().toISOString() }).eq('id', inserted.id)
        }
      } else {
        console.warn(`No email found for ${recipient.type} ${recipient.id}`)
      }

      results.push({ recipient: recipient.id, notification: true, email: emailSent })
    }

    // 2. Direct admin emails (no DB notification row needed)
    const adminTargets: string[] = [
      ...(notify_admins ? ADMIN_EMAILS : []),
      ...direct_emails,
    ]
    const uniqueAdminTargets = [...new Set(adminTargets)]

    for (const adminEmail of uniqueAdminTargets) {
      const { subject, html } = buildEmail(type, 'admin', details, refType)
      const sent = await sendEmail(adminEmail, subject, html)
      results.push({ recipient: adminEmail, notification: false, email: sent })
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('send-notification error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
