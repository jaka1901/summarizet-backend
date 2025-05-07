require('dotenv').config()
const express = require('express')
const multer = require('multer')
const cors = require('cors')
const pdfParse = require('pdf-parse')
const mammoth = require('mammoth')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const app = express()
const upload = multer({ dest: 'uploads/' })

app.use(cors())
app.use(express.json())


const MAX_TOKEN_LENGTH = 450; // Adjust to stay within token limit
const MAX_OUTPUT_LENGTH = 200; // Max length of the output (to prevent cut-off)
const WAIT_BETWEEN_REQUESTS = 300; // ms

// Approximate token counting by splitting based on spaces (simple approximation)
function countTokens(text) {
  return text.split(/\s+/).length; // Count tokens by space-split
}

function chunkText(text, maxLength = MAX_TOKEN_LENGTH) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    // If adding the sentence doesn't exceed the max chunk length, add it to the current chunk
    if ((currentChunk + sentence).length <= maxLength) {
      currentChunk += sentence;
    } else {
      // Push the current chunk to the array and start a new one
      chunks.push(currentChunk.trim());
      currentChunk = sentence;  // Start a new chunk with the current sentence
    }
  }

  // Add the last chunk if it has content
  if (currentChunk) chunks.push(currentChunk.trim());

  return chunks;
}

async function summarizeText(text) {
  const apiUrl = process.env.HUGGING_FACE_MODEL_TEXT;
  const headers = {
    Authorization: `Bearer ${process.env.HUGGING_FACE_API_KEY}`,
    'Content-Type': 'application/json'
  };

  // Chunk the text by tokens (using words approximation)
  const chunks = chunkText(text);
  const summaries = [];

  for (const chunk of chunks) {
    const body = {
      inputs: `summarize: ${chunk}`,
      parameters: {
        max_length: MAX_OUTPUT_LENGTH,  // Limit the output length to avoid cut-off
        num_beams: 4,     // Optional: for more coherent summaries
        length_penalty: 2.0, // Optional: to adjust for longer summaries
        do_sample: false,
        num_return_sequences: 1,        // Only return 1 translation
        no_repeat_ngram_size: 2,        // Avoid repetition in output
      }
    };

    try {
      const response = await axios.post(apiUrl, body, { headers });
      console.log(response.data);
      const summary = response.data?.[0]?.translation_text || response.data?.translation_text || '';
      summaries.push(summary);
    } catch (err) {
      console.error('❌ Summarization failed for chunk:', err);
    }

    await new Promise(res => setTimeout(res, WAIT_BETWEEN_REQUESTS));
  }

  // Combine summaries and check if further summarization is needed
  const joined = summaries.join(' ');
  return countTokens(joined) > MAX_TOKEN_LENGTH
    ? await summarizeText(joined) // Recursive summarization if joined text is still too long
    : joined;
}


app.get('/api', async(req, res) => {
  res.status(200).json({
    message: "WELCOME!"
  })
})

// TEXT → SUMMARY
app.post('/api/summarize', async (req, res) => {
  const { text } = req.body
  if (!text) return res.status(400).json({ error: 'Text is required' })
  try {
    const summary = await summarizeText(text)
    res.json({ summary })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Summarization failed' })
  }
})

// FILE (PDF/DOCX) → SUMMARY
app.post('/api/summarize-file', upload.single('file'), async (req, res) => {
  const filePath = req.file.path
  const fileExtension = path.extname(req.file.originalname).toLowerCase()
  try {
    let fileContent = ''
    if (fileExtension === '.pdf') {
      const pdfData = await pdfParse(fs.readFileSync(filePath))
      fileContent = pdfData.text
    } else if (fileExtension === '.docx') {
      const docxData = await mammoth.extractRawText({ path: filePath })
      fileContent = docxData.value
    } else {
      return res.status(400).json({ error: 'Unsupported file type.' })
    }
    const summary = await summarizeText(fileContent)
    res.json({ summary })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'File processing failed' })
  } finally {
    fs.unlinkSync(filePath)
  }
})

app.post('/api/summarize-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const response = await fetch(url);
    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return res.status(400).json({ error: 'Failed to extract content from URL' });
    }

    const summary = await summarizeText(article.textContent);
    res.json({ summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'URL summarization failed' });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('✅ Server running on port', process.env.PORT || 3000)
})
