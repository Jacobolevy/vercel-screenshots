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
  // --- INICIO DE LOGS DE DEPURACIÓN ---
  console.log('--- Depuración de Endpoint ---');
  console.log('keyText recibido:', req.body.keyText);
  console.log('figmaFileUrl recibido:', req.body.figmaFileUrl);
  console.log('figmaPageName recibido:', req.body.figmaPageName);

  const figmaFileUrl = req.body.figmaFileUrl;
  const keyText = req.body.keyText;
  const figmaPageName = req.body.figmaPageName;

  // Validación básica de los parámetros
  if (!keyText || !figmaFileUrl) {
    console.error('Error: Faltan keyText o figmaFileUrl en la petición (validación inicial).');
    return res.status(400).json({ error: 'Missing parameters: keyText or figmaFileUrl.' });
  }

  try {
    // 1. Extraer el ID del archivo de Figma de la URL proporcionada
    // Regex mejorada: acepta /file/ o /design/ y hace opcional la barra final después del ID.
    // También captura cualquier carácter (excepto /) para el ID, haciéndolo más permisivo.
    const fileIdMatch = figmaFileUrl.match(/\/(file|design)\/([^/]+)\/?/);
    
    console.log('Resultado de fileIdMatch:', fileIdMatch); // Muestra el array completo de la coincidencia
    if (fileIdMatch && fileIdMatch.length >= 3) {
      console.log('fileIdMatch[0] (match completo):', fileIdMatch[0]);
      console.log('fileIdMatch[1] (tipo URL - file/design):', fileIdMatch[1]);
      console.log('fileIdMatch[2] (POSIBLE ID DEL ARCHIVO):', fileIdMatch[2]);
    } else {
      console.error('Error: figmaFileUrl.match no encontró suficientes grupos de captura o no hubo match.');
    }

    // CRÍTICO: Asegura que fileIdMatch y el grupo de captura para el ID existen
    if (!fileIdMatch || !fileIdMatch[2]) {
      console.error(`Error: URL de Figma inválida (REGEX NO MATCH): ${figmaFileUrl}`);
      // Esta es la línea que te está dando el error "Invalid Figma file URL."
      return res.status(400).json({ error: 'Invalid Figma file URL.' }); 
    }
    
    // CORRECCIÓN CLAVE: El ID del archivo de Figma está en el segundo grupo de captura ([2])
    const figmaFileId = fileIdMatch[2]; 
    console.log('Figma File ID extraído (figmaFileId):', figmaFileId);

    // 2. Obtener los datos del archivo de Figma para buscar el nodo (capa/texto)
    console.log('Token de Figma (existencia):', !!FIGMA_ACCESS_TOKEN); // Solo verifica si existe, no muestra el valor
    const figmaApiResponse = await axios.get(`https://api.figma.com/v1/files/${figmaFileId}`, {
      headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN }
    });
    console.log('Respuesta de la API de Figma (status):', figmaApiResponse.status);
    // Puedes loguear parte de la data si necesitas ver el árbol de Figma, pero puede ser muy grande.
    // console.log('Respuesta de la API de Figma (data - primera parte):', JSON.stringify(figmaApiResponse.data).substring(0, 500)); 

    const figmaData = figmaApiResponse.data;

    let targetNodeId = null;

    // Función recursiva para buscar el nodo por texto (o nombre de capa)
    function findNodeByText(nodes, searchText) {
        if (!nodes) return null;
        for (const node of nodes) {
            console.log(`Buscando en nodo: "${node.name || 'N/A'}" (tipo: ${node.type})`);
            // Opción 1: Buscar en el nombre de la capa/nodo
            if (node.name && node.name.includes(searchText)) {
                console.log(`¡Nodo encontrado por nombre! ID: ${node.id}`);
                return node.id;
            }
            // Opción 2: Si el nodo es de texto, buscar en su contenido de texto
            if (node.type === 'TEXT' && node.characters && node.characters.includes(searchText)) {
                console.log(`¡Nodo de texto encontrado por contenido! ID: ${node.id}`);
                return node.id;
            }
            // Si el nodo tiene hijos, buscar recursivamente
            if (node.children) {
                const foundId = findNodeByText(node.children, searchText);
                if (foundId) return foundId;
            }
        }
        return null;
    }

    // Determina dónde buscar el nodo: en una página específica o en todas las páginas/lienzos
    let searchScopeNodes = figmaData.document.children; 
    if (figmaPageName) {
        const pageNode = figmaData.document.children.find(
            page => page.type === 'CANVAS' && page.name === figmaPageName
        );
        if (pageNode) {
            searchScopeNodes = pageNode.children;
            console.log(`Ámbito de búsqueda limitado a la página: ${figmaPageName}`);
        } else {
            console.warn(`Página de Figma "${figmaPageName}" no encontrada. Buscando en todo el archivo.`);
        }
    }

    // Realiza la búsqueda del nodo con el texto clave
    console.log(`Iniciando búsqueda de nodo para "${keyText}"...`);
    targetNodeId = findNodeByText(searchScopeNodes, keyText);
    console.log('Target Node ID encontrado:', targetNodeId);

    if (!targetNodeId) {
        console.warn(`Nodo de Figma no encontrado para el texto: "${keyText}" en el archivo: "${figmaFileId}" (Página: ${figmaPageName || 'Cualquiera'}).`);
        return res.status(404).json({ error: 'Figma node not found for the specified text.', key: keyText });
    }

    // 3. Generar la URL de la imagen (renderización) del nodo específico de Figma
    console.log(`Generando URL de imagen para el nodo ID: ${targetNodeId}`);
    const imageUrlResponse = await axios.get(
      `https://api.figma.com/v1/images/${figmaFileId}?ids=${targetNodeId}&scale=2`,
      { headers: { 'X-Figma-Token': FIGMA_ACCESS_TOKEN } }
    );
    const imageUrls = imageUrlResponse.data.images;
    const figmaRenderedImageUrl = imageUrls[targetNodeId]; 
    console.log('URL de imagen de Figma generada:', figmaRenderedImageUrl);

    if (!figmaRenderedImageUrl) {
      console.error(`Error: No se pudo obtener la URL de renderizado de Figma para el nodo: ${targetNodeId}`);
      return res.status(500).json({ error: 'Could not get Figma rendered image URL for the node.' });
    }

    // 4. Descargar la imagen de Figma y subirla a Cloudinary
    console.log('Subiendo imagen a Cloudinary...');
    const publicId = `${keyText.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50)}_${Date.now()}`;
    const cloudinaryUploadResult = await cloudinary.uploader.upload(figmaRenderedImageUrl, {
      folder: 'figma-screenshots',
      public_id: publicId
    });
    console.log('Imagen subida a Cloudinary. URL:', cloudinaryUploadResult.secure_url);

    // Envía la URL segura de la imagen subida de vuelta a Google Apps Script
    res.json({ imageUrl: cloudinaryUploadResult.secure_url });

  } catch (error) {
    console.error('--- Error atrapado en el endpoint ---');
    console.error('Mensaje de error:', error.message);
    if (error.response) {
      console.error('Error Response Status (HTTP):', error.response.status);
      console.error('Error Response Data (Figma/otros):', error.response.data);
    } else if (error.request) {
      console.error('Error Request (no response received):', error.request);
    } else {
      console.error('Error Config (Axios config issue):', error.config);
    }
    // Devolver un error genérico al cliente
    res.status(500).json({ error: 'Internal server error while processing screenshot.' });
  }
});

// Exporta la instancia de Express para que Vercel pueda usarla como una función sin servidor
module.exports = app;