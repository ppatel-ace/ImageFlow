import { Client } from '@microsoft/microsoft-graph-client';

let connectionSettings: any;

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('Authentication required. Please connect to SharePoint.');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=sharepoint',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token ?? connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('SharePoint not connected. Please connect your SharePoint account.');
  }
  return accessToken;
}

export async function getSharePointClient() {
  const accessToken = await getAccessToken();

  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
    // Use Government Community Cloud (GCC) endpoint
    baseUrl: 'https://graph.microsoft.us/v1.0'
  });
}

async function ensureFolder(client: any, siteId: string, folderPath: string) {
  try {
    // Try to get the folder
    await client.api(`/sites/${siteId}/drive/root:/${folderPath}`).get();
  } catch (error: any) {
    if (error.statusCode === 404) {
      // Folder doesn't exist, create it
      const pathParts = folderPath.split('/');
      let currentPath = '';
      
      for (const part of pathParts) {
        const parentPath = currentPath || '/';
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        
        try {
          // Try to get the folder
          await client.api(`/sites/${siteId}/drive/root:/${currentPath}`).get();
        } catch (err: any) {
          if (err.statusCode === 404) {
            // Create the folder
            const createPath = parentPath === '/' 
              ? `/sites/${siteId}/drive/root/children`
              : `/sites/${siteId}/drive/root:/${parentPath}:/children`;
            
            await client.api(createPath).post({
              name: part,
              folder: {},
              '@microsoft.graph.conflictBehavior': 'rename'
            });
          } else {
            throw err;
          }
        }
      }
    } else {
      throw error;
    }
  }
}

export async function uploadFileToSharePoint(
  customerName: string,
  dept: string,
  workOrderNumber: string,
  fileName: string,
  fileBuffer: Buffer
) {
  const client = await getSharePointClient();
  
  // Upload to SharePoint site's default document library
  // Path structure: ACE/CustomerName/Dept/WorkOrderNumber/filename
  const folderPath = `ACE/${customerName}/${dept}/${workOrderNumber}`;
  
  // First, get the site ID (use root site)
  const site = await client.api('/sites/root').get();
  const siteId = site.id;
  
  // Ensure the folder structure exists
  await ensureFolder(client, siteId, folderPath);
  
  // Upload to the default document library
  const filePath = `/sites/${siteId}/drive/root:/${folderPath}/${fileName}:/content`;
  
  await client
    .api(filePath)
    .put(fileBuffer);
  
  return {
    success: true,
    path: `${folderPath}/${fileName}`
  };
}
