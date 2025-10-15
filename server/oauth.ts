import { google } from 'googleapis';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOKEN_PATH = join(__dirname, '..', '.gmail-tokens.json');

// OAuth2 scopes for Gmail
// Only need gmail.readonly - it includes full read access including search
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly'
];

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

// Get OAuth2 client
export function getOAuth2Client() {
  const redirectUri = process.env.REPLIT_DOMAINS 
    ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}/oauth/callback`
    : 'http://localhost:5000/oauth/callback';

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

// Generate authorization URL
export function getAuthUrl() {
  const oauth2Client = getOAuth2Client();
  
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Force consent screen to get refresh token
  });
}

// Exchange authorization code for tokens
export async function getTokensFromCode(code: string): Promise<TokenData> {
  const oauth2Client = getOAuth2Client();
  
  const { tokens } = await oauth2Client.getToken(code);
  
  // Save tokens to file
  saveTokens(tokens as TokenData);
  
  return tokens as TokenData;
}

// Save tokens to file
function saveTokens(tokens: TokenData) {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

// Load tokens from file
export function loadTokens(): TokenData | null {
  if (!existsSync(TOKEN_PATH)) {
    return null;
  }
  
  try {
    const data = readFileSync(TOKEN_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading tokens:', error);
    return null;
  }
}

// Check if tokens exist and are valid
export function hasValidTokens(): boolean {
  const tokens = loadTokens();
  if (!tokens || !tokens.access_token) {
    return false;
  }
  
  // If token is expired but we have a refresh token, still consider it valid
  // The getGmailClient function will handle refreshing it automatically
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    return !!tokens.refresh_token; // Valid if we have a refresh token
  }
  
  return true;
}

// Get authenticated Gmail client
export async function getGmailClient() {
  const oauth2Client = getOAuth2Client();
  const tokens = loadTokens();
  
  if (!tokens) {
    throw new Error('No tokens available. Please authenticate first.');
  }
  
  oauth2Client.setCredentials(tokens);
  
  // Check if token is expired and refresh if needed
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    if (tokens.refresh_token) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        saveTokens(credentials as TokenData);
        oauth2Client.setCredentials(credentials);
      } catch (error) {
        console.error('Error refreshing token:', error);
        throw new Error('Token refresh failed. Please re-authenticate.');
      }
    } else {
      throw new Error('Token expired and no refresh token available. Please re-authenticate.');
    }
  }
  
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Revoke tokens (disconnect)
export async function revokeTokens() {
  const oauth2Client = getOAuth2Client();
  const tokens = loadTokens();
  
  if (tokens && tokens.access_token) {
    try {
      await oauth2Client.revokeToken(tokens.access_token);
    } catch (error) {
      console.error('Error revoking token:', error);
    }
  }
  
  // Delete token file
  if (existsSync(TOKEN_PATH)) {
    writeFileSync(TOKEN_PATH, '');
  }
}
