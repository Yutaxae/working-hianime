import { megacloud } from '../parsers/decryptor/megacloud.js';
import { getServers } from '../controllers/serversController.js';
import axios from 'axios';

/**
 * Extract streaming data from HD-4 (megaplay.buzz)
 * HD-4 uses a different provider that requires fetching the embed page
 * and extracting the streaming sources from there
 */
async function extractHD4Stream(epID, serverType) {
  const TIMEOUT = 15000;
  const megaplayUrl = `https://megaplay.buzz/stream/s-2/${epID}/${serverType}`;

  try {
    console.log(`HD-4: Fetching embed page from ${megaplayUrl}`);

    // Fetch the embed page to get the data-id
    const { data: html } = await axios.get(megaplayUrl, {
      headers: {
        'Referer': 'https://megaplay.buzz/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: TIMEOUT,
    });

    // Extract the data-id from the embed page
    const dataIdMatch = html.match(/data-id=["'](\d+)["']/);
    const realId = dataIdMatch?.[1];

    if (!realId) {
      console.log('HD-4: Could not extract data-id from embed page');
      // Return basic response as fallback
      return {
        streamingLink: megaplayUrl,
        servers: 'HD-4',
        error: 'Could not extract streaming data',
      };
    }

    console.log(`HD-4: Extracted data-id: ${realId}, fetching sources...`);

    // Fetch the actual streaming sources
    const { data: sourcesData } = await axios.get(
      `https://megaplay.buzz/stream/getSources?id=${realId}`,
      {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': megaplayUrl,
        },
        timeout: TIMEOUT,
      }
    );

    if (!sourcesData?.sources?.file) {
      console.log('HD-4: No streaming file in sources response');
      return {
        streamingLink: megaplayUrl,
        servers: 'HD-4',
        error: 'No streaming file found',
      };
    }

    const directUrl = sourcesData.sources.file;
    const encodedUrl = encodeURIComponent(directUrl);
    const encodedReferer = encodeURIComponent('https://megaplay.buzz');
    const proxiedUrl = `https://working-hianime.vercel.app/api/v1/proxy?url=${encodedUrl}&referer=${encodedReferer}`;

    console.log('HD-4: Successfully extracted streaming link');

    // Return in the same format as other servers
    return {
      id: `${epID}`,
      type: serverType,
      link: {
        file: proxiedUrl,
        directUrl: directUrl,
        proxyUrl: proxiedUrl,
        type: 'hls',
      },
      tracks: sourcesData.tracks || [],
      intro: sourcesData.intro || null,
      outro: sourcesData.outro || null,
      server: 'HD-4',
      usedFallback: false,
    };

  } catch (error) {
    console.error('HD-4 extraction failed:', error.message);
    // Return basic response as fallback
    return {
      streamingLink: megaplayUrl,
      servers: 'HD-4',
      error: error.message,
    };
  }
}

export const extractStream = async ({ selectedServer, id }) => {
  const epID = id.split('ep=').pop();

  // Handle HD-4 with proper extraction instead of just returning embed URL
  if (selectedServer.name === 'HD-4') {
    return await extractHD4Stream(epID, selectedServer.type);
  }

  const streamingLink = await megacloud({ selectedServer, id });

  if (streamingLink && streamingLink.link && streamingLink.link.file) {
    const directUrl = streamingLink.link.file;

    // Extract the correct referer from the streaming URL domain
    // CDNs check referer headers - using wrong referer causes 403 Forbidden
    let referer = 'https://megacloud.tv';
    try {
      const streamUrl = new URL(directUrl);
      referer = `${streamUrl.protocol}//${streamUrl.host}`;
    } catch (e) {
      console.log('Could not parse streaming URL for referer, using default megacloud.tv');
    }

    const encodedUrl = encodeURIComponent(directUrl);
    const encodedReferer = encodeURIComponent(referer);
    const proxiedUrl = `https://working-hianime.vercel.app/api/v1/proxy?url=${encodedUrl}&referer=${encodedReferer}`;

    streamingLink.link.directUrl = directUrl;
    streamingLink.link.file = proxiedUrl;
    streamingLink.link.proxyUrl = proxiedUrl;

    if (selectedServer.type === 'dub' && (!streamingLink.tracks || streamingLink.tracks.filter(t => t.kind === 'captions').length === 0)) {
      try {
        console.log('DUB episode has no subtitles, attempting to fetch from SUB version...');
        const allServers = await getServers(id);

        const subServer = allServers.sub.find(s => s.name === selectedServer.name || s.index === selectedServer.index);

        if (subServer && subServer.id) {
          console.log('Found matching SUB server, fetching subtitles...');
          const subStreamData = await megacloud({ selectedServer: subServer, id });

          if (subStreamData && subStreamData.tracks) {
            const subTitles = subStreamData.tracks.filter(t => t.kind === 'captions' || t.kind === 'subtitles');

            if (subTitles.length > 0) {
              console.log(`Found ${subTitles.length} subtitle tracks from SUB version`)
              streamingLink.tracks = [...(streamingLink.tracks || []), ...subTitles];
            }
          }
        }
      } catch (error) {
        console.log('Failed to fetch subtitles from SUB version:', error.message);
      }
    }
  }

  return streamingLink;
};
