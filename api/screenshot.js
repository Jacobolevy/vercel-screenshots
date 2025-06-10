const axios = require('axios');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const FIGMA_ACCESS_TOKEN = process.env.FIGMA_ACCESS_TOKEN;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { figmaFileUrl, keyText, figmaPageName } = req.body;

  if (!keyText || !figmaFileUrl) {
    return res.status(400).json({ error: 'Missing parameters: keyText or figmaFileUrl.' });
  }

  try {
    // Normaliza la URL para que /design/ pase a /file/
    const normalizedUrl = figmaFileUrl.replace('/design/', '/file/');

    // Regex para extraer el ID del archivo
    const fileIdMatch = normalizedUrl.match(/\/file\/([^/]+)\/?/);
    if (!fileIdMatch || !fileIdMatch[1]) {
      return res.status(400).json({ error: 'Invalid Figma file URL.' });
    }
    const figmaFileId = fileIdMatch[1];

    const figmaApiResponse = await axios.get(`https://api.figma.com/v1/files/${figmaFileId}`, {
      headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN }
    });
    const figmaData = figmaApiResponse.data;

    function findNodeByText(nodes, searchText) {
      if (!nodes) return null;
      for (const node of nodes) {
        if (node.name && node.name.includes(searchText)) return node.id;
        if (node.type === 'TEXT' && node.characters && node.characters.includes(searchText)) return node.id;
        if (node.children) {
          const foundId = findNodeByText(node.children, searchText);
          if (foundId) return foundId;
        }
      }
      return null;
    }

    let searchScopeNodes = figmaData.document.children;
    if (figmaPageName) {
      const pageNode = searchScopeNodes.find(p => p.type === 'CANVAS' && p.name === figmaPageName);
      if (pageNode) searchScopeNodes = pageNode.children;
    }

    const targetNodeId = findNodeByText(searchScopeNodes, keyText);
    if (!targetNodeId) {
      return res.status(404).json({ error: 'Figma node not found for the specified text.', key: keyText });
    }

    const imageUrlResponse = await axios.get(
      `https://api.figma.com/v1/images/${figmaFileId}?ids=${targetNodeId}&scale=2`,
      { headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN } }
    );
    const figmaRenderedImageUrl = imageUrlResponse.data.images[targetNodeId];
    if (!figmaRenderedImageUrl) {
      return res.status(500).json({ error: 'Could not get Figma rendered image URL for the node.' });
    }

    const publicId = `${keyText.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50)}_${Date.now()}`;
    const cloudinaryUploadResult = await cloudinary.uploader.upload(figmaRenderedImageUrl, {
      folder: 'figma-screenshots',
      public_id: publicId
    });

    res.json({ imageUrl: cloudinaryUploadResult.secure_url });

  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) console.error(error.response.data);
    res.status(500).json({ error: 'Internal server error while processing screenshot.' });
  }
};
