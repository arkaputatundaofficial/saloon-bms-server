const fs = require('fs');
const path = require('path');
const os = require('os');

// Use the OS temp directory which is writable in serverless environments like Vercel
const OTP_FILE_PATH = path.join(os.tmpdir(), 'otps.json');

// Initialize the file if it doesn't exist
if (!fs.existsSync(OTP_FILE_PATH)) {
    fs.writeFileSync(OTP_FILE_PATH, JSON.stringify({}));
}

function getOtps() {
    try {
        const data = fs.readFileSync(OTP_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("Error reading OTPs file:", err);
        return {};
    }
}

function saveOtps(otps) {
    try {
        fs.writeFileSync(OTP_FILE_PATH, JSON.stringify(otps, null, 2));
    } catch (err) {
        console.error("Error saving OTPs file:", err);
    }
}

function generateOTP(email) {
    const otps = getOtps();
    
    // Cleanup expired OTPs before generating new one
    const now = Date.now();
    for (const key in otps) {
        if (now - otps[key].timestamp > 5 * 60 * 1000) {
            delete otps[key];
        }
    }

    // Generate a 4-digit code
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    
    otps[email] = {
        otp: otp,
        timestamp: now
    };
    
    saveOtps(otps);
    return otp;
}

function verifyOTP(email, otp) {
    const otps = getOtps();
    const userOtp = otps[email];
    
    if (!userOtp) {
        return false;
    }
    
    const now = Date.now();
    // Check if expired (5 minutes = 300,000 ms)
    if (now - userOtp.timestamp > 5 * 60 * 1000) {
        delete otps[email];
        saveOtps(otps);
        return false;
    }
    
    // Check if OTP matches
    if (userOtp.otp === otp) {
        delete otps[email];
        saveOtps(otps);
        return true;
    }
    
    return false;
}

module.exports = {
    generateOTP,
    verifyOTP
};
