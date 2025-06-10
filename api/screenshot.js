// figma-screenshot-endpoint/api/screenshot.js
const express = require('express');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;

const app = express();
// Middleware para que Express pueda leer el cuerpo de las peticiones en formato JSON
app.use(express.json());

// Configuración de Cloudinary. Las variables de entorno se cargarán automáticamente por Vercel.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Tu token de acceso personal de Figma. Se configurará como variable de entorno en Vercel.
const FIGMA_ACCESS_TOKEN = process.env.FIGMA_ACCESS_TOKEN;

// Este es el endpoint que tu Google Apps Script llamará
// La ruta es '/api/screenshot' porque el archivo está en 'api/screenshot.js'
app.post('/api/screenshot', async (req, res) => {
  // Extrae los datos enviados desde Google Apps Script
  const { keyText, figmaFileUrl, figmaPageName } = req.body;

  // Validación básica de los parámetros
  if (!keyText || !figmaFileUrl) {
    console.error('Error: Faltan keyText o figmaFileUrl en la petición.');
    return res.status(400).json({ error: 'Missing parameters: keyText or figmaFileUrl.' });
  }

  try {
    // 1. Extraer el ID del archivo de Figma de la URL proporcionada
    const fileIdMatch = figmaFileUrl.match(/\/(file|design)\/([a-zA-Z0-9]+)\/?/);
    if (!fileIdMatch) {
      console.error(`Error: URL de Figma inválida: ${figmaFileUrl}`);
      return res.status(400).json({ error: 'Invalid Figma file URL.' });
    }
    const figmaFileId = fileIdMatch[2];

    // 2. Obtener los datos del archivo de Figma para buscar el nodo (capa/texto)
    const figmaApiResponse = await axios.get(`https://api.figma.com/v1/files/${figmaFileId}`, {
      headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN }
    });
    const figmaData = figmaApiResponse.data;

    let targetNodeId = null;

    // Función recursiva para buscar el nodo por texto (o nombre de capa)
    // Puedes ajustar esta lógica para que se adapte mejor a cómo identificas tus "keys" en Figma
    function findNodeByText(nodes, searchText) {
        if (!nodes) return null; // Asegura que no haya errores si 'children' es undefined
        for (const node of nodes) {
            // Opción 1: Buscar en el nombre de la capa/nodo
            if (node.name && node.name.includes(searchText)) {
                return node.id;
            }
            // Opción 2: Si el nodo es de texto, buscar en su contenido de texto
            if (node.type === 'TEXT' && node.characters && node.characters.includes(searchText)) {
                return node.id;
            }
            // Si el nodo tiene hijos, buscar recursivamente
            if (node.children) {
                const foundId = findNodeByText(node.children, searchText);
                if (foundId) return foundId;
            }
        }
        return null; // Nodo no encontrado en este nivel
    }

    // Determina dónde buscar el nodo: en una página específica o en todas las páginas/lienzos
    let searchScopeNodes = figmaData.document.children; // Por defecto, busca en todos los lienzos (páginas)
    if (figmaPageName) {
        // Si se especificó una página, busca esa página primero
        const pageNode = figmaData.document.children.find(
            page => page.type === 'CANVAS' && page.name === figmaPageName
        );
        if (pageNode) {
            searchScopeNodes = pageNode.children; // Limita la búsqueda a los hijos de esa página
            console.log(`Buscando en la página de Figma: ${figmaPageName}`);
        } else {
            console.warn(`Página de Figma "${figmaPageName}" no encontrada. Buscando en todo el archivo.`);
            // Si la página no se encuentra, se mantiene el ámbito de búsqueda original (todo el archivo)
        }
    }

    // Realiza la búsqueda del nodo con el texto clave
    targetNodeId = findNodeByText(searchScopeNodes, keyText);

    if (!targetNodeId) {
        console.warn(`Nodo de Figma no encontrado para el texto: "${keyText}" en el archivo: "${figmaFileId}" (Página: ${figmaPageName || 'Cualquiera'}).`);
        // Devolver un error 404 si el nodo no se encuentra
        return res.status(404).json({ error: 'Figma node not found for the specified text.', key: keyText });
    }

    // 3. Generar la URL de la imagen (renderización) del nodo específico de Figma
    // `scale=2` genera la imagen al doble de resolución para mayor calidad
    const imageUrlResponse = await axios.get(
      `https://api.figma.com/v1/images/${figmaFileId}?ids=${targetNodeId}&scale=2`,
      { headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN } }
    );
    const imageUrls = imageUrlResponse.data.images;
    const figmaRenderedImageUrl = imageUrls[targetNodeId]; // Obtiene la URL de la imagen del nodo específico

    if (!figmaRenderedImageUrl) {
        console.error(`Error: No se pudo obtener la URL de renderizado de Figma para el nodo: ${targetNodeId}`);
        return res.status(500).json({ error: 'Could not get Figma rendered image URL for the node.' });
    }

    // 4. Descargar la imagen de Figma y subirla a Cloudinary
    // Se usa el 'public_id' para darle un nombre único a la imagen en Cloudinary
    const publicId = `${keyText.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50)}_${Date.now()}`; // Limita el nombre a 50 caracteres y añade timestamp
    const cloudinaryUploadResult = await cloudinary.uploader.upload(figmaRenderedImageUrl, {
      folder: 'figma-screenshots', // Puedes cambiar el nombre de la carpeta en Cloudinary
      public_id: publicId
    });

    // Envía la URL segura de la imagen subida de vuelta a Google Apps Script
    res.json({ imageUrl: cloudinaryUploadResult.secure_url });

  } catch (error) {
    console.error('Error en el endpoint al generar la captura de pantalla:', error.message);
    // Para depuración, puedes loguear la respuesta completa de Axios si hay un error HTTP
    if (error.response) {
        console.error('Detalles del error de la API (Figma/otros):', error.response.status, error.response.data);
    }
    // Devolver un error genérico al cliente
    res.status(500).json({ error: 'Internal server error while processing screenshot.' });
  }
});

// Exporta la instancia de Express para que Vercel pueda usarla como una función sin servidor
module.exports = app;