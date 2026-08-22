const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticate } = require('../middleware/auth');
const router = express.Router();
const supabase = require('../supabaseClient');
const emailjs = require('@emailjs/nodejs');
const crypto = require('crypto');

// Reversible encryption helpers using AES-256-CBC
const ENCRYPTION_KEY = (process.env.SUPABASE_SECRET || 'fallback_secret_key_32_chars_long').substring(0, 32);
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return "";
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return "";
    try {
        let textParts = text.split(':');
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        console.error("Decryption failed:", e);
        return "";
    }
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    // Create an ephemeral client so we don't poison the global service_role client with a user session
    const tempClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
    
    const { data, error } = await tempClient.auth.signInWithPassword({
        email,
        password
    });

    if (error) {
        return res.status(401).json({ error: error.message });
    }

    const { data: profile } = await supabase
        .from('profiles')
        .select('role, full_name, password')
        .eq('id', data.user.id)
        .single();

    const decryptedPassword = profile?.password || "";

    res.json({
        ...data,
        user: {
            ...data.user,
            role: profile?.role || null,
            full_name: profile?.full_name || null,
            password: decryptedPassword
        }
    });
});

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
    const { email, password, full_name, role } = req.body;
    
    // Create an ephemeral client so we don't poison the global service_role client
    const tempClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
    
    const { data, error } = await tempClient.auth.signUp({
        email,
        password
    });

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    // Attempt to insert profile. Note: Requires RLS insert policy on profiles or service role key
    if (data.user) {
        try {
            // Generate unique uid
            let uid;
            let isUnique = false;
            while (!isUnique) {
                uid = 'user_' + crypto.randomBytes(3).toString('hex');
                const { data: existing } = await supabase
                    .from('profiles')
                    .select('id')
                    .eq('uid', uid)
                    .maybeSingle();
                if (!existing) {
                    isUnique = true;
                }
            }

            const { error: profileError } = await supabase
                .from('profiles')
                .insert([{
                    id: data.user.id,
                    full_name: full_name || '',
                    role: role || 'employee',
                    email: email,
                    password: password,
                    uid: uid
                }]);
                
            if (profileError) {
                console.error("Profile creation error:", profileError.message);
            }
        } catch (err) {
            console.error("Failed to initialize admin client:", err.message);
        }
    }

    res.json({ success: true, user: data.user });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        // For MVP, signing out the token locally or on Supabase.
        // The client supabase instance is required to do this properly
        // but frontend dropping the token is sufficient for this scope.
    }
    res.json({ success: true });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    
    // Check if user exists via profiles table
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('id, email')
        .eq('email', email)
        .single();
    
    if (error || !profile) {
        return res.status(404).json({ error: "User with this email not found." });
    }
    
    // Clean up expired OTPs (older than 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase.from('otps').delete().lt('created_at', fiveMinutesAgo);

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    
    // Upsert into Supabase otps table
    const { error: otpError } = await supabase
        .from('otps')
        .upsert([{ email, otp, created_at: new Date().toISOString() }]);

    if (otpError) {
        console.error("Supabase OTP Error:", otpError);
        return res.status(500).json({ error: "Failed to store OTP." });
    }
    
    try {
        await emailjs.send(
            process.env.EMAILJS_SERVICE_ID,
            process.env.EMAILJS_TEMPLATE_ID,
            {
                email: email,
                otp: otp
            },
            {
                publicKey: process.env.EMAILJS_PUBLIC_KEY,
                privateKey: process.env.EMAILJS_PRIVATE_KEY
            }
        );
        res.json({ success: true, message: "OTP sent to email." });
    } catch (err) {
        console.error("EmailJS Error:", err);
        res.status(500).json({ error: "Failed to send OTP email." });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    
    // Query OTP from Supabase
    const { data: otpData, error: otpError } = await supabase
        .from('otps')
        .select('*')
        .eq('email', email)
        .single();
        
    if (otpError || !otpData) {
        return res.status(400).json({ error: "Invalid OTP or email." });
    }
    
    // Check expiration robustly (ensure it parses as UTC if missing timezone offset)
    let createdAtString = otpData.created_at;
    if (!createdAtString.endsWith('Z') && !createdAtString.includes('+') && !createdAtString.includes('-')) {
        createdAtString += 'Z';
    }
    const createdAt = new Date(createdAtString).getTime();
    
    if (Date.now() - createdAt > 5 * 60 * 1000) {
        // Delete expired OTP
        await supabase.from('otps').delete().eq('email', email);
        return res.status(400).json({ error: "OTP has expired." });
    }
    
    // Check if OTP matches
    if (otpData.otp !== otp) {
        return res.status(400).json({ error: "Invalid OTP." });
    }
    
    // OTP is valid, delete it
    await supabase.from('otps').delete().eq('email', email);
    
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('id, email')
        .eq('email', email)
        .single();
    
    if (error || !profile) {
        return res.status(404).json({ error: "User not found." });
    }
    
    const { error: updateError } = await supabase.auth.admin.updateUserById(
        profile.id,
        { password: newPassword }
    );
    
    if (updateError) {
        return res.status(500).json({ error: updateError.message });
    }

    // Update password in public.profiles table in plaintext
    const { error: profileUpdateError } = await supabase
        .from('profiles')
        .update({ password: newPassword })
        .eq('id', profile.id);

    if (profileUpdateError) {
        return res.status(500).json({ error: "Failed to update profiles table: " + profileUpdateError.message });
    }
    
    res.json({ success: true, message: "Password updated successfully." });
});

// GET /api/auth/profile
router.get('/profile', authenticate, async (req, res) => {
    try {
        let targetId = req.user.id;
        if (req.query.id && req.query.id !== req.user.id) {
            // Check if requester is admin
            const { data: requesterProfile } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', req.user.id)
                .single();
            if (!requesterProfile || requesterProfile.role !== 'admin') {
                return res.status(403).json({ error: "Access denied. Only admins can view other user profiles." });
            }
            targetId = req.query.id;
        }

        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', targetId)
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        
        res.json({
            ...req.user,
            profile: data || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/auth/account
router.delete('/account', authenticate, async (req, res) => {
    try {
        if (!process.env.SUPABASE_SECRET) {
            return res.status(500).json({ error: "Server missing SUPABASE_SECRET to perform account deletion." });
        }
        
        // 1. Unlink user from any invoices to prevent foreign key constraint violations
        const { error: unlinkError } = await supabase
            .from('invoices')
            .update({ employee_id: null })
            .eq('employee_id', req.user.id);
            
        if (unlinkError) {
            console.error("Warning: Failed to unlink invoices:", unlinkError);
        }

        // 2. Explicitly delete profile to resolve any constraints
        const { error: profileError } = await supabase
            .from('profiles')
            .delete()
            .eq('id', req.user.id);
            
        if (profileError) {
            console.error("Warning: Failed to delete profile:", profileError);
        }

        // 3. Use global admin key to delete user from Auth
        const { error } = await supabase.auth.admin.deleteUser(req.user.id);
        
        if (error) {
            console.error("Supabase deleteUser error:", error);
            throw error;
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error("Account deletion exception:", err);
        res.status(500).json({ error: err.message || err });
    }
});

// PUT /api/auth/profile
router.put('/profile', authenticate, async (req, res) => {
    try {
        const { id, full_name, email, password, uid } = req.body;
        if (!full_name || !email) {
            return res.status(400).json({ error: "Name and email are required" });
        }

        let targetId = id || req.user.id;
        if (targetId !== req.user.id) {
            // Check if requester is admin
            const { data: requesterProfile } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', req.user.id)
                .single();
            if (!requesterProfile || requesterProfile.role !== 'admin') {
                return res.status(403).json({ error: "Access denied. Only admins can update other user profiles." });
            }
        }

        // Check if email already exists on another account
        const { data: existingUser, error: checkError } = await supabase
            .from('profiles')
            .select('id')
            .eq('email', email)
            .neq('id', targetId)
            .maybeSingle();

        if (checkError) throw checkError;
        if (existingUser) {
            return res.status(400).json({ error: "Email already exists" });
        }

        // Check if UID already exists on another account
        if (uid) {
            const { data: existingUidUser, error: uidCheckError } = await supabase
                .from('profiles')
                .select('id')
                .eq('uid', uid)
                .neq('id', targetId)
                .maybeSingle();

            if (uidCheckError) throw uidCheckError;
            if (existingUidUser) {
                return res.status(400).json({ error: "User ID already exists" });
            }
        }

        // Fetch current profile email and password to log in tempClient
        const { data: targetProfile, error: targetProfileErr } = await supabase
            .from('profiles')
            .select('email, password')
            .eq('id', targetId)
            .single();

        if (targetProfileErr) throw targetProfileErr;

        const currentDecryptedPassword = targetProfile.password || "";

        // Create standard temp client using public key
        const tempClient = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_KEY,
            { auth: { persistSession: false, autoRefreshToken: false } }
        );

        // Sign in as target user to establish standard user auth session context
        const { error: loginErr } = await tempClient.auth.signInWithPassword({
            email: targetProfile.email,
            password: currentDecryptedPassword
        });

        if (loginErr) {
            return res.status(500).json({ error: "Failed to establish target user auth session: " + loginErr.message });
        }

        // 1. Update Supabase Auth details using standard updateUser
        const updateParams = {
            data: { full_name: full_name }
        };
        if (email !== targetProfile.email) {
            updateParams.email = email;
        }
        if (password) {
            updateParams.password = password;
        }

        const { error: authError } = await tempClient.auth.updateUser(updateParams);
        if (authError) {
            return res.status(500).json({ error: "Failed to update auth details: " + authError.message });
        }

        // 2. Update profiles table
        const updateData = { full_name, email };
        if(email) {
            updateData.email = email;
        }
        if (password) {
            updateData.password = password;
        }
        if (uid) {
            updateData.uid = uid;
        }

        const { data, error } = await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', targetId)
            .select()
            .single();

        if (error) throw error;

        res.json({
            success: true,
            profile: data
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
