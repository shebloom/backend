import { URLSearchParams } from 'url';

/**
 * Server-side helper to upload a video buffer directly to Cloudinary.
 */
export async function uploadVideoBufferToCloudinary(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string = 'video/mp4'
): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'jmrbgice';
  const apiKey = process.env.CLOUDINARY_API_KEY || '616414298695773';
  const apiSecret = process.env.CLOUDINARY_API_SECRET || 'v_Tyzpf9Yv9TYxo7SrDa5BMZ9S8';

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder = 'shebloom_wellness_videos';
  
  // Calculate SHA-1 signature for Cloudinary authenticated upload
  const crypto = await import('crypto');
  const signatureString = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(signatureString).digest('hex');

  const base64Data = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;

  const params = new URLSearchParams();
  params.append('file', base64Data);
  params.append('api_key', apiKey);
  params.append('timestamp', timestamp);
  params.append('folder', folder);
  params.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, {
    method: 'POST',
    body: params,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Cloudinary video upload failed (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as any;
  if (!data?.secure_url) {
    throw new Error('Cloudinary response did not contain secure_url');
  }

  return data.secure_url;
}
