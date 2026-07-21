import tiktoken
import openai
import logging
import os
import re as _re
import base64 as _base64
from datetime import datetime
import time
import json
import PyPDF2
import copy
import asyncio
import pymupdf
from io import BytesIO
from dotenv import load_dotenv
load_dotenv()
import logging
import yaml
from pathlib import Path
from types import SimpleNamespace as config

CHATGPT_API_KEY = os.getenv("CHATGPT_API_KEY")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", None)

# ── Azure OpenAI configuration ────────────────────────────────
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", None)
AZURE_API_VERSION = os.getenv("AZURE_API_VERSION", "2025-04-01-preview")
USE_AZURE = bool(AZURE_OPENAI_ENDPOINT)  # auto-detect Azure mode

# ── vLLM local server configuration ──────────────────────────
_VLLM_BASE_URL = None  # e.g. "http://localhost:8000/v1"

# ── Concurrency control ──────────────────────────────────────
_LLM_SEMAPHORE: asyncio.Semaphore | None = None
_MAX_CONCURRENCY: int = 24  # default; overridden by config


def set_max_concurrency(n: int):
    """Set the maximum number of concurrent async LLM calls.

    Must be called before the first async LLM call (typically in
    ``page_index_main``).
    """
    global _MAX_CONCURRENCY, _LLM_SEMAPHORE
    _MAX_CONCURRENCY = max(1, n)
    _LLM_SEMAPHORE = None  # reset; lazily created on first use


def _get_semaphore() -> asyncio.Semaphore:
    """Return (and lazily create) the global concurrency semaphore."""
    global _LLM_SEMAPHORE
    if _LLM_SEMAPHORE is None:
        _LLM_SEMAPHORE = asyncio.Semaphore(_MAX_CONCURRENCY)
    return _LLM_SEMAPHORE


def set_vllm_url(url):
    """Set the vLLM server URL. When set, all LLM calls go through this server.

    Args:
        url: vLLM OpenAI-compatible API URL (e.g. "http://localhost:8000/v1").
             Pass None or "" to disable.
    """
    global _VLLM_BASE_URL
    _VLLM_BASE_URL = url.rstrip('/') if url else None


def get_vllm_url():
    """Return the current vLLM server URL, or None if not set."""
    return _VLLM_BASE_URL


def is_vllm_mode():
    """Return True if vLLM local server mode is active."""
    return _VLLM_BASE_URL is not None


def _get_azure_token_provider():
    """Create Azure AD token provider (cached at module level)."""
    from azure.identity import AzureCliCredential, get_bearer_token_provider
    credential = AzureCliCredential()
    return get_bearer_token_provider(
        credential, "https://cognitiveservices.azure.com/.default"
    )


# Lazily initialized Azure token provider
_azure_token_provider = None


def _ensure_azure_token_provider():
    global _azure_token_provider
    if _azure_token_provider is None:
        _azure_token_provider = _get_azure_token_provider()
    return _azure_token_provider


def create_openai_client():
    """Factory: create OpenAI or AzureOpenAI client based on env config.

    Priority: vLLM local server > Azure OpenAI > standard OpenAI.
    When _VLLM_BASE_URL is set (via set_vllm_url), returns an OpenAI client
    pointing to the local vLLM server.
    When AZURE_OPENAI_ENDPOINT is set, returns an AzureOpenAI client
    using Azure AD token authentication (matching test_api.py pattern).
    Otherwise returns a standard OpenAI client.
    """
    if _VLLM_BASE_URL:
        return openai.OpenAI(base_url=_VLLM_BASE_URL, api_key="EMPTY")
    if USE_AZURE:
        token_provider = _ensure_azure_token_provider()
        return openai.AzureOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            azure_ad_token_provider=token_provider,
            api_version=AZURE_API_VERSION,
        )
    return openai.OpenAI(api_key=CHATGPT_API_KEY, base_url=OPENAI_BASE_URL)


def create_async_openai_client():
    """Factory: create async OpenAI or AzureOpenAI client based on env config."""
    if _VLLM_BASE_URL:
        return openai.AsyncOpenAI(base_url=_VLLM_BASE_URL, api_key="EMPTY")
    if USE_AZURE:
        token_provider = _ensure_azure_token_provider()
        return openai.AsyncAzureOpenAI(
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            azure_ad_token_provider=token_provider,
            api_version=AZURE_API_VERSION,
        )
    return openai.AsyncOpenAI(api_key=CHATGPT_API_KEY, base_url=OPENAI_BASE_URL)

# ── Thinking control for Qwen models ──────────────────────────────────
# Module-level setting so that all ChatGPT_API* calls automatically pick
# it up without threading through every intermediate function signature.
_GLOBAL_ENABLE_THINKING = None          # None = auto (API default)


def set_enable_thinking(value):
    """Set the global enable_thinking flag for all subsequent API calls.

    Args:
        value: True  – force thinking on
               False – force thinking off (saves tokens & latency)
               None  – auto (let the API decide, default)
    """
    global _GLOBAL_ENABLE_THINKING
    _GLOBAL_ENABLE_THINKING = value


def get_enable_thinking():
    """Return the current global enable_thinking setting."""
    return _GLOBAL_ENABLE_THINKING


def _get_tiktoken_encoding(model):
    """Get tiktoken encoding, falling back to cl100k_base for unknown models (e.g. Qwen)."""
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError:
        return tiktoken.get_encoding("cl100k_base")


def count_tokens(text, model=None):
    if not text:
        return 0
    enc = _get_tiktoken_encoding(model)
    # Some real-world PDFs contain strings like "<|endoftext|>" in extracted text.
    # Treat them as normal text to avoid ValueError on disallowed special tokens.
    tokens = enc.encode(text, disallowed_special=())
    return len(tokens)

def _build_user_message(prompt, images=None):
    """Build user message content, optionally with images for multimodal VLM."""
    if images:
        content = [{"type": "text", "text": prompt}]
        for img_b64 in images:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{img_b64}"}
            })
        return content
    return prompt


def _is_qwen_model(model: str) -> bool:
    """Check if model name indicates a Qwen series model."""
    if not model:
        return False
    m = model.lower()
    return 'qwen' in m


def _is_gpt5_model(model: str) -> bool:
    """Check if model name indicates a GPT-5 series model.

    GPT-5 does not support custom temperature — only the default (1) is allowed.
    """
    if not model:
        return False
    m = model.lower()
    return 'gpt-5' in m or 'gpt5' in m


def _filter_temperature(model: str, temperature) -> dict:
    """Return {'temperature': value} or {} if the model doesn't support it.

    GPT-5 only allows the default temperature (1), so we omit the parameter.
    """
    if _is_gpt5_model(model):
        return {}
    return {"temperature": temperature}


def _completion_tokens_kwargs(model: str, max_tokens: int | None) -> dict:
    """Return model-compatible token limit kwargs for chat.completions.create().

    GPT-5 uses `max_completion_tokens`, while most other OpenAI-compatible
    endpoints still use `max_tokens`.
    """
    if max_tokens is None:
        return {}
    if _is_gpt5_model(model):
        return {"max_completion_tokens": max_tokens}
    return {"max_tokens": max_tokens}


def _build_extra_kwargs(model: str, enable_thinking=None) -> dict:
    """Build extra kwargs for chat.completions.create().

    For Qwen models via DashScope API, adds extra_body={"enable_thinking": ...}
    when enable_thinking is explicitly set to True/False.
    For vLLM mode, uses chat_template_kwargs to control thinking via Jinja2 template.
    When enable_thinking is None (auto), no extra_body is added,
    letting the API use its default behavior.

    Falls back to the global _GLOBAL_ENABLE_THINKING when the caller
    does not pass an explicit value.
    """
    val = enable_thinking if enable_thinking is not None else _GLOBAL_ENABLE_THINKING
    if val is not None and _is_qwen_model(model):
        if _VLLM_BASE_URL:
            # vLLM: control thinking via chat_template_kwargs
            return {"extra_body": {"chat_template_kwargs": {"enable_thinking": bool(val)}}}
        else:
            # DashScope API: direct enable_thinking param
            return {"extra_body": {"enable_thinking": bool(val)}}
    return {}


def ChatGPT_API_with_finish_reason(model, prompt, api_key=CHATGPT_API_KEY, chat_history=None, images=None, enable_thinking=None):
    max_retries = 10
    client = create_openai_client()
    extra_kwargs = _build_extra_kwargs(model, enable_thinking)
    for i in range(max_retries):
        try:
            if chat_history:
                messages = list(chat_history)
                messages.append({"role": "user", "content": _build_user_message(prompt, images)})
            else:
                messages = [{"role": "user", "content": _build_user_message(prompt, images)}]
            
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                **_filter_temperature(model, 0),
                **extra_kwargs,
            )
            if response.choices[0].finish_reason == "length":
                content = response.choices[0].message.content
                # For thinking models: if thinking was truncated but the actual
                # answer (after </think>) contains valid JSON, treat as finished
                if _VLLM_BASE_URL and content:
                    stripped = _strip_thinking_tags(content)
                    if stripped != content and stripped:
                        # Thinking was stripped and there's remaining content
                        return stripped, "finished"
                return content, "max_output_reached"
            else:
                return response.choices[0].message.content, "finished"

        except KeyboardInterrupt:
            raise  # 不拦截 Ctrl+C
        except Exception as e:
            print('************* Retrying *************')
            logging.error(f"Error: {e}")
            if i < max_retries - 1:
                time.sleep(1)  # Wait for 1秒 before retrying
            else:
                logging.error('Max retries reached for prompt: ' + prompt)
                return "Error", "error"



def ChatGPT_API(model, prompt, api_key=CHATGPT_API_KEY, chat_history=None, images=None, enable_thinking=None):
    max_retries = 10
    client = create_openai_client()
    extra_kwargs = _build_extra_kwargs(model, enable_thinking)
    for i in range(max_retries):
        try:
            if chat_history:
                messages = list(chat_history)
                messages.append({"role": "user", "content": _build_user_message(prompt, images)})
            else:
                messages = [{"role": "user", "content": _build_user_message(prompt, images)}]
            
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                **_filter_temperature(model, 0),
                **extra_kwargs,
            )
   
            return response.choices[0].message.content
        except KeyboardInterrupt:
            raise  # 不拦截 Ctrl+C
        except Exception as e:
            print('************* Retrying *************')
            logging.error(f"Error: {e}")
            if i < max_retries - 1:
                time.sleep(1)  # Wait for 1秒 before retrying
            else:
                logging.error('Max retries reached for prompt: ' + prompt)
                return "Error"
            

async def ChatGPT_API_async(model, prompt, api_key=CHATGPT_API_KEY, images=None, enable_thinking=None):
    """Async LLM call with global concurrency throttling (Semaphore)."""
    sem = _get_semaphore()
    max_retries = 10
    messages = [{"role": "user", "content": _build_user_message(prompt, images)}]
    extra_kwargs = _build_extra_kwargs(model, enable_thinking)
    for i in range(max_retries):
        try:
            async with sem:
                async with create_async_openai_client() as client:
                    response = await client.chat.completions.create(
                        model=model,
                        messages=messages,
                        **_filter_temperature(model, 0),
                        **extra_kwargs,
                    )
                    return response.choices[0].message.content
        except KeyboardInterrupt:
            raise  # 不拦截 Ctrl+C
        except Exception as e:
            print('************* Retrying *************')
            logging.error(f"Error: {e}")
            if i < max_retries - 1:
                await asyncio.sleep(1)  # Wait for 1s before retrying
            else:
                logging.error('Max retries reached for prompt: ' + prompt)
                return "Error"  
            
            
def get_json_content(response):
    start_idx = response.find("```json")
    if start_idx != -1:
        start_idx += 7
        response = response[start_idx:]
        
    end_idx = response.rfind("```")
    if end_idx != -1:
        response = response[:end_idx]
    
    json_content = response.strip()
    return json_content
         

def _strip_thinking_tags(content: str) -> str:
    """Strip <think>...</think> blocks and inline thinking preamble from model output.

    Handles three patterns:
    1. Explicit <think>...</think> blocks (full tags)
    2. Only </think> tag (Qwen3-VL-Thinking: chat template adds <think>,
       model generates thinking + </think> + answer)
    3. Inline thinking text before JSON (fallback to extract_json brace search)
    """
    if not content:
        return content
    # Pattern 1: explicit <think>...</think> blocks
    stripped = _re.sub(r'<think>.*?</think>\s*', '', content, flags=_re.DOTALL).strip()
    if stripped and stripped != content.strip():
        return stripped
    # Pattern 2: only </think> tag (opening <think> was in chat template prefix)
    think_end = content.find('</think>')
    if think_end != -1:
        after = content[think_end + len('</think>'):].strip()
        if after:
            return after
    # No thinking tags found, return as-is (extract_json will handle brace search)
    return content


def extract_json(content):
    if not content:
        return {}
    # Strip <think>...</think> blocks first
    content = _strip_thinking_tags(content)
    try:
        # First, try to extract JSON enclosed within ```json and ```
        start_idx = content.find("```json")
        if start_idx != -1:
            start_idx += 7  # Adjust index to start after the delimiter
            end_idx = content.rfind("```")
            json_content = content[start_idx:end_idx].strip()
        else:
            # Try to find the first { or [ that starts a JSON structure
            brace_idx = content.find('{')
            bracket_idx = content.find('[')
            if brace_idx == -1 and bracket_idx == -1:
                json_content = content.strip()
            elif brace_idx == -1:
                json_content = content[bracket_idx:].strip()
            elif bracket_idx == -1:
                json_content = content[brace_idx:].strip()
            else:
                first_idx = min(brace_idx, bracket_idx)
                json_content = content[first_idx:].strip()

        # Clean up common issues that might cause parsing errors
        json_content = json_content.replace('None', 'null')  # Replace Python None with JSON null
        json_content = json_content.replace('\n', ' ').replace('\r', ' ')  # Remove newlines
        json_content = ' '.join(json_content.split())  # Normalize whitespace

        # Attempt to parse and return the JSON object
        return json.loads(json_content)
    except json.JSONDecodeError as e:
        logging.error(f"Failed to extract JSON: {e}")
        # Try to clean up the content further if initial parsing fails
        try:
            # Remove any trailing commas before closing brackets/braces
            json_content = json_content.replace(',]', ']').replace(',}', '}')
            return json.loads(json_content)
        except:
            logging.error("Failed to parse JSON even after cleanup")
            return {}
    except Exception as e:
        logging.error(f"Unexpected error while extracting JSON: {e}")
        return {}

def write_node_id(data, node_id=0):
    if isinstance(data, dict):
        data['node_id'] = str(node_id).zfill(4)
        node_id += 1
        for key in list(data.keys()):
            if 'nodes' in key:
                node_id = write_node_id(data[key], node_id)
    elif isinstance(data, list):
        for index in range(len(data)):
            node_id = write_node_id(data[index], node_id)
    return node_id

def get_nodes(structure):
    if isinstance(structure, dict):
        structure_node = copy.deepcopy(structure)
        structure_node.pop('nodes', None)
        nodes = [structure_node]
        for key in list(structure.keys()):
            if 'nodes' in key:
                nodes.extend(get_nodes(structure[key]))
        return nodes
    elif isinstance(structure, list):
        nodes = []
        for item in structure:
            nodes.extend(get_nodes(item))
        return nodes
    
def structure_to_list(structure):
    if isinstance(structure, dict):
        nodes = []
        nodes.append(structure)
        if 'nodes' in structure:
            nodes.extend(structure_to_list(structure['nodes']))
        return nodes
    elif isinstance(structure, list):
        nodes = []
        for item in structure:
            nodes.extend(structure_to_list(item))
        return nodes

    
def get_leaf_nodes(structure):
    if isinstance(structure, dict):
        if not structure.get('nodes'):
            structure_node = copy.deepcopy(structure)
            structure_node.pop('nodes', None)
            return [structure_node]
        else:
            leaf_nodes = []
            for key in list(structure.keys()):
                if 'nodes' in key:
                    leaf_nodes.extend(get_leaf_nodes(structure[key]))
            return leaf_nodes
    elif isinstance(structure, list):
        leaf_nodes = []
        for item in structure:
            leaf_nodes.extend(get_leaf_nodes(item))
        return leaf_nodes

def is_leaf_node(data, node_id):
    # Helper function to find the node by its node_id
    def find_node(data, node_id):
        if isinstance(data, dict):
            if data.get('node_id') == node_id:
                return data
            for key in data.keys():
                if 'nodes' in key:
                    result = find_node(data[key], node_id)
                    if result:
                        return result
        elif isinstance(data, list):
            for item in data:
                result = find_node(item, node_id)
                if result:
                    return result
        return None

    # Find the node with the given node_id
    node = find_node(data, node_id)

    # Check if the node is a leaf node
    if node and not node.get('nodes'):
        return True
    return False

def get_last_node(structure):
    return structure[-1]


def extract_text_from_pdf(pdf_path):
    pdf_reader = PyPDF2.PdfReader(pdf_path)
    ###return text not list 
    text=""
    for page_num in range(len(pdf_reader.pages)):
        page = pdf_reader.pages[page_num]
        text+=page.extract_text()
    return text

def get_pdf_title(pdf_path):
    pdf_reader = PyPDF2.PdfReader(pdf_path)
    meta = pdf_reader.metadata
    title = meta.title if meta and meta.title else 'Untitled'
    return title

def get_text_of_pages(pdf_path, start_page, end_page, tag=True):
    pdf_reader = PyPDF2.PdfReader(pdf_path)
    text = ""
    for page_num in range(start_page-1, end_page):
        page = pdf_reader.pages[page_num]
        page_text = page.extract_text()
        if tag:
            text += f"<start_index_{page_num+1}>\n{page_text}\n<end_index_{page_num+1}>\n"
        else:
            text += page_text
    return text

def get_first_start_page_from_text(text):
    start_page = -1
    start_page_match = _re.search(r'<start_index_(\d+)>', text)
    if start_page_match:
        start_page = int(start_page_match.group(1))
    return start_page

def get_last_start_page_from_text(text):
    start_page = -1
    # Find all matches of start_index tags
    start_page_matches = _re.finditer(r'<start_index_(\d+)>', text)
    # Convert iterator to list and get the last match if any exist
    matches_list = list(start_page_matches)
    if matches_list:
        start_page = int(matches_list[-1].group(1))
    return start_page


def sanitize_filename(filename, replacement='-'):
    # In Linux, only '/' and '\0' (null) are invalid in filenames.
    # Null can't be represented in strings, so we only handle '/'.
    return filename.replace('/', replacement)

def get_pdf_name(pdf_path):
    # Extract PDF name
    if isinstance(pdf_path, str):
        pdf_name = os.path.basename(pdf_path)
    elif isinstance(pdf_path, BytesIO):
        pdf_reader = PyPDF2.PdfReader(pdf_path)
        meta = pdf_reader.metadata
        pdf_name = meta.title if meta and meta.title else 'Untitled'
        pdf_name = sanitize_filename(pdf_name)
    return pdf_name


class JsonLogger:
    def __init__(self, file_path):
        # Extract PDF name for logger name
        pdf_name = get_pdf_name(file_path)
            
        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.filename = f"{pdf_name}_{current_time}.json"
        os.makedirs("./logs", exist_ok=True)
        # Initialize empty list to store all messages
        self.log_data = []

    def log(self, level, message, **kwargs):
        if isinstance(message, dict):
            self.log_data.append(message)
        else:
            self.log_data.append({'message': message})
        # Add new message to the log data
        
        # Write entire log data to file
        with open(self._filepath(), "w") as f:
            json.dump(self.log_data, f, indent=2)

    def info(self, message, **kwargs):
        self.log("INFO", message, **kwargs)

    def error(self, message, **kwargs):
        self.log("ERROR", message, **kwargs)

    def debug(self, message, **kwargs):
        self.log("DEBUG", message, **kwargs)

    def exception(self, message, **kwargs):
        kwargs["exception"] = True
        self.log("ERROR", message, **kwargs)

    def _filepath(self):
        return os.path.join("logs", self.filename)
    



def list_to_tree(data):
    def get_parent_structure(structure):
        """Helper function to get the parent structure code"""
        if not structure:
            return None
        parts = str(structure).split('.')
        return '.'.join(parts[:-1]) if len(parts) > 1 else None
    
    # First pass: Create nodes and track parent-child relationships
    nodes = {}
    root_nodes = []
    
    for item in data:
        structure = item.get('structure')
        node = {
            'title': item.get('title'),
            'start_index': item.get('start_index'),
            'end_index': item.get('end_index'),
            'nodes': []
        }
        
        nodes[structure] = node
        
        # Find parent
        parent_structure = get_parent_structure(structure)
        
        if parent_structure:
            # Add as child to parent if parent exists
            if parent_structure in nodes:
                nodes[parent_structure]['nodes'].append(node)
            else:
                root_nodes.append(node)
        else:
            # No parent, this is a root node
            root_nodes.append(node)
    
    # Helper function to clean empty children arrays
    def clean_node(node):
        if not node['nodes']:
            del node['nodes']
        else:
            for child in node['nodes']:
                clean_node(child)
        return node
    
    # Clean and return the tree
    return [clean_node(node) for node in root_nodes]

def add_preface_if_needed(data):
    if not isinstance(data, list) or not data:
        return data

    if data[0]['physical_index'] is not None and data[0]['physical_index'] > 1:
        preface_node = {
            "structure": "0",
            "title": "Preface",
            "physical_index": 1,
        }
        data.insert(0, preface_node)
    return data



def get_page_tokens(pdf_path, model="gpt-4o-2024-11-20", pdf_parser="PyPDF2"):
    enc = _get_tiktoken_encoding(model)
    if pdf_parser == "PyPDF2":
        pdf_reader = PyPDF2.PdfReader(pdf_path)
        page_list = []
        for page_num in range(len(pdf_reader.pages)):
            page = pdf_reader.pages[page_num]
            page_text = page.extract_text()
            token_length = len(enc.encode(page_text or "", disallowed_special=()))
            page_list.append((page_text, token_length))
        return page_list
    elif pdf_parser == "PyMuPDF":
        if isinstance(pdf_path, BytesIO):
            pdf_stream = pdf_path
            doc = pymupdf.open(stream=pdf_stream, filetype="pdf")
        elif isinstance(pdf_path, str) and os.path.isfile(pdf_path) and pdf_path.lower().endswith(".pdf"):
            doc = pymupdf.open(pdf_path)
        page_list = []
        for page in doc:
            page_text = page.get_text()
            token_length = len(enc.encode(page_text or "", disallowed_special=()))
            page_list.append((page_text, token_length))
        return page_list
    else:
        raise ValueError(f"Unsupported PDF parser: {pdf_parser}")


def render_all_pages_to_base64(pdf_path, zoom=1.5):
    """Pre-render all pages of a PDF to base64 PNG images.

    Args:
        pdf_path: Path to the PDF file or BytesIO object.
        zoom: Rendering zoom factor (default 1.5).

    Returns:
        dict: {page_number_1based: base64_str}
    """
    if isinstance(pdf_path, BytesIO):
        doc = pymupdf.open(stream=pdf_path, filetype="pdf")
    else:
        doc = pymupdf.open(pdf_path)
    page_images = {}
    try:
        matrix = pymupdf.Matrix(zoom, zoom)
        for i in range(len(doc)):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=matrix)
            img_bytes = pix.tobytes("png")
            b64 = _base64.b64encode(img_bytes).decode("utf-8")
            page_images[i + 1] = b64  # 1-based page numbers
    finally:
        doc.close()
    print(f"[Vision] Pre-rendered {len(page_images)} pages (zoom={zoom})")
    return page_images


def extract_page_nums_from_text(text):
    """Extract page numbers from <physical_index_X> tags in grouped text."""
    matches = _re.findall(r'<physical_index_(\d+)>', text)
    return sorted(set(int(m) for m in matches))


def get_images_for_pages(page_nums, page_images):
    """Get base64 images for specific page numbers from pre-rendered dict.

    Returns:
        list of base64 strings, or None if page_images is None/empty.
    """
    if not page_images:
        return None
    images = [page_images[p] for p in page_nums if p in page_images]
    return images if images else None


def extract_images_from_markdown(text, md_dir):
    """Extract inline images from markdown text.

    Parses ``![alt](path)`` patterns and encodes each referenced image as
    base64.  Paths are resolved relative to *md_dir* (the directory that
    contains the source ``.md`` file).

    Returns:
        list of (alt_text, base64_str) tuples for images that exist on disk.
    """
    pattern = _re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')
    results = []
    seen = set()
    for alt, rel_path in pattern.findall(text):
        # Strip optional title in quotes: ![alt](path "title")
        rel_path = rel_path.split('"')[0].split("'")[0].strip()
        abs_path = os.path.normpath(os.path.join(md_dir, rel_path))
        if abs_path in seen or not os.path.isfile(abs_path):
            continue
        seen.add(abs_path)
        # Determine MIME type from extension
        ext = os.path.splitext(abs_path)[1].lower()
        mime_map = {'.png': 'image/png', '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                    '.webp': 'image/webp', '.svg': 'image/svg+xml'}
        mime = mime_map.get(ext, 'image/png')
        with open(abs_path, 'rb') as f:
            b64 = _base64.b64encode(f.read()).decode('utf-8')
        results.append((alt or os.path.basename(rel_path), b64, mime))
    return results


def get_md_node_images(node, md_dir):
    """Extract images embedded in a markdown node's text.

    Returns list of base64 strings suitable for ``_build_user_message()``.
    Returns None if no images found.
    """
    text = node.get('text', '')
    if not text or not md_dir:
        return None
    img_tuples = extract_images_from_markdown(text, md_dir)
    if not img_tuples:
        return None
    return [b64 for (_, b64, _) in img_tuples]


def get_md_node_images_with_meta(node, md_dir):
    """Extract images with alt text and MIME type from a markdown node.

    Returns list of (alt_text, base64_str, mime_type), or empty list.
    """
    text = node.get('text', '')
    if not text or not md_dir:
        return []
    return extract_images_from_markdown(text, md_dir)


def get_text_of_pdf_pages(pdf_pages, start_page, end_page):
    text = ""
    for page_num in range(start_page-1, end_page):
        text += pdf_pages[page_num][0]
    return text

def get_text_of_pdf_pages_with_labels(pdf_pages, start_page, end_page):
    text = ""
    for page_num in range(start_page-1, end_page):
        text += f"<physical_index_{page_num+1}>\n{pdf_pages[page_num][0]}\n<physical_index_{page_num+1}>\n"
    return text

def get_number_of_pages(pdf_path):
    pdf_reader = PyPDF2.PdfReader(pdf_path)
    num = len(pdf_reader.pages)
    return num



def post_processing(structure, end_physical_index):
    # First convert page_number to start_index in flat list
    for i, item in enumerate(structure):
        item['start_index'] = item.get('physical_index')
        if i < len(structure) - 1:
            if structure[i + 1].get('appear_start') == 'yes':
                item['end_index'] = structure[i + 1]['physical_index']-1
            else:
                item['end_index'] = structure[i + 1]['physical_index']
        else:
            item['end_index'] = end_physical_index
    tree = list_to_tree(structure)
    if len(tree)!=0:
        return tree
    else:
        ### remove appear_start 
        for node in structure:
            node.pop('appear_start', None)
            node.pop('physical_index', None)
        return structure

def clean_structure_post(data):
    if isinstance(data, dict):
        data.pop('page_number', None)
        data.pop('start_index', None)
        data.pop('end_index', None)
        if 'nodes' in data:
            clean_structure_post(data['nodes'])
    elif isinstance(data, list):
        for section in data:
            clean_structure_post(section)
    return data

def remove_fields(data, fields=['text']):
    if isinstance(data, dict):
        return {k: remove_fields(v, fields)
            for k, v in data.items() if k not in fields}
    elif isinstance(data, list):
        return [remove_fields(item, fields) for item in data]
    return data

def print_toc(tree, indent=0):
    for node in tree:
        print('  ' * indent + node['title'])
        if node.get('nodes'):
            print_toc(node['nodes'], indent + 1)

def print_json(data, max_len=40, indent=2):
    def simplify_data(obj):
        if isinstance(obj, dict):
            return {k: simplify_data(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [simplify_data(item) for item in obj]
        elif isinstance(obj, str) and len(obj) > max_len:
            return obj[:max_len] + '...'
        else:
            return obj
    
    simplified = simplify_data(data)
    print(json.dumps(simplified, indent=indent, ensure_ascii=False))


def remove_structure_text(data):
    if isinstance(data, dict):
        data.pop('text', None)
        if 'nodes' in data:
            remove_structure_text(data['nodes'])
    elif isinstance(data, list):
        for item in data:
            remove_structure_text(item)
    return data


def check_token_limit(structure, limit=110000):
    list = structure_to_list(structure)
    for node in list:
        num_tokens = count_tokens(node['text'], model='gpt-4o')
        if num_tokens > limit:
            print(f"Node ID: {node['node_id']} has {num_tokens} tokens")
            print("Start Index:", node['start_index'])
            print("End Index:", node['end_index'])
            print("Title:", node['title'])
            print("\n")


def convert_physical_index_to_int(data):
    if isinstance(data, list):
        for i in range(len(data)):
            # Check if item is a dictionary and has 'physical_index' key
            if isinstance(data[i], dict) and 'physical_index' in data[i]:
                if isinstance(data[i]['physical_index'], str):
                    if data[i]['physical_index'].startswith('<physical_index_'):
                        data[i]['physical_index'] = int(data[i]['physical_index'].split('_')[-1].rstrip('>').strip())
                    elif data[i]['physical_index'].startswith('physical_index_'):
                        data[i]['physical_index'] = int(data[i]['physical_index'].split('_')[-1].strip())
                    else:
                        # Handle plain numeric strings returned by some models, e.g. "12".
                        value = data[i]['physical_index'].strip()
                        if value.isdigit():
                            data[i]['physical_index'] = int(value)
    elif isinstance(data, str):
        if data.startswith('<physical_index_'):
            data = int(data.split('_')[-1].rstrip('>').strip())
        elif data.startswith('physical_index_'):
            data = int(data.split('_')[-1].strip())
        elif data.strip().isdigit():
            data = int(data.strip())
        # Check data is int
        if isinstance(data, int):
            return data
        else:
            return None
    return data


def convert_page_to_int(data):
    for item in data:
        if 'page' in item and isinstance(item['page'], str):
            try:
                item['page'] = int(item['page'])
            except ValueError:
                # Keep original value if conversion fails
                pass
    return data


def add_node_text(node, pdf_pages):
    if isinstance(node, dict):
        start_page = node.get('start_index')
        end_page = node.get('end_index')
        node['text'] = get_text_of_pdf_pages(pdf_pages, start_page, end_page)
        if 'nodes' in node:
            add_node_text(node['nodes'], pdf_pages)
    elif isinstance(node, list):
        for index in range(len(node)):
            add_node_text(node[index], pdf_pages)
    return


def add_node_text_with_labels(node, pdf_pages):
    if isinstance(node, dict):
        start_page = node.get('start_index')
        end_page = node.get('end_index')
        node['text'] = get_text_of_pdf_pages_with_labels(pdf_pages, start_page, end_page)
        if 'nodes' in node:
            add_node_text_with_labels(node['nodes'], pdf_pages)
    elif isinstance(node, list):
        for index in range(len(node)):
            add_node_text_with_labels(node[index], pdf_pages)
    return


async def generate_node_summary(node, model=None, page_images=None, md_dir=None):
    images = None
    # PDF vision: lookup page images by start_index / end_index
    if page_images:
        start = node.get('start_index', 0)
        end = node.get('end_index', start)
        images = get_images_for_pages(range(start, end + 1), page_images)
    # Markdown vision: extract inline images from node text
    if not images and md_dir:
        images = get_md_node_images(node, md_dir)

    vision_hint = ""
    if images:
        vision_hint = (
            "\n\nIMPORTANT: Page images are provided alongside the text. "
            "Use BOTH the text and images to produce a comprehensive summary. "
            "Pay special attention to any figures, tables, charts, diagrams, "
            "or other visual elements that may not be fully captured in the text."
        )

    prompt = f"""You are tasked with creating a comprehensive summary of a section from a document. Your summary should focus on extracting and describing the main content, tables, figures, and images present in this section.

Follow these steps:
1. Carefully read and analyze the section content.
2. Identify the main topics, key points, and important details (especially numerical data, statistics, or key facts).
3. Note any tables, figures, charts, diagrams, or images and briefly describe their content and purpose.
4. Create a structured summary that captures:
   - The essential textual information
   - Descriptions of any visual elements (tables, figures, images, etc.)
   - Any particularly notable or unique information
{vision_hint}

Section Text:
{node['text']}

Present your summary in the following format. The summary should be concise yet comprehensive (4-7 sentences for text, with additional sentences as needed for visual elements):

[Main text content summary]

[Table]: Table X: [Brief description of what the table shows, including key column/row headers]
[Figure]: Figure X: [Brief description of what the figure depicts, including chart type and data shown]
[Image]: [Brief description of image content]

Only include [Table]/[Figure]/[Image] lines if such elements actually exist. Return the summary directly without any wrapper tags or extra text."""
    response = await ChatGPT_API_async(model, prompt, images=images)
    return response


async def generate_summaries_for_structure(structure, model=None, page_images=None, md_dir=None):
    nodes = structure_to_list(structure)
    tasks = [generate_node_summary(node, model=model, page_images=page_images, md_dir=md_dir) for node in nodes]
    summaries = await asyncio.gather(*tasks)
    
    for node, summary in zip(nodes, summaries):
        node['summary'] = summary
    return structure


def create_clean_structure_for_description(structure):
    """
    Create a clean structure for document description generation,
    excluding unnecessary fields like 'text'.
    """
    if isinstance(structure, dict):
        clean_node = {}
        # Only include essential fields for description
        for key in ['title', 'node_id', 'summary', 'prefix_summary']:
            if key in structure:
                clean_node[key] = structure[key]
        
        # Recursively process child nodes
        if 'nodes' in structure and structure['nodes']:
            clean_node['nodes'] = create_clean_structure_for_description(structure['nodes'])
        
        return clean_node
    elif isinstance(structure, list):
        return [create_clean_structure_for_description(item) for item in structure]
    else:
        return structure


def generate_doc_description(structure, model=None):
    prompt = f"""Your are an expert in generating descriptions for a document.
    You are given a structure of a document. Your task is to generate a one-sentence description for the document, which makes it easy to distinguish the document from other documents.
        
    Document Structure: {structure}
    
    Directly return the description, do not include any other text.
    """
    response = ChatGPT_API(model, prompt)
    return response


def reorder_dict(data, key_order):
    if not key_order:
        return data
    return {key: data[key] for key in key_order if key in data}


def format_structure(structure, order=None):
    if not order:
        return structure
    if isinstance(structure, dict):
        if 'nodes' in structure:
            structure['nodes'] = format_structure(structure['nodes'], order)
        if not structure.get('nodes'):
            structure.pop('nodes', None)
        structure = reorder_dict(structure, order)
    elif isinstance(structure, list):
        structure = [format_structure(item, order) for item in structure]
    return structure


class ConfigLoader:
    def __init__(self, default_path: str = None):
        if default_path is None:
            default_path = Path(__file__).parent / "config.yaml"
        self._default_dict = self._load_yaml(default_path)

    @staticmethod
    def _load_yaml(path):
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    def _validate_keys(self, user_dict):
        unknown_keys = set(user_dict) - set(self._default_dict)
        if unknown_keys:
            raise ValueError(f"Unknown config keys: {unknown_keys}")

    def load(self, user_opt=None) -> config:
        """
        Load the configuration, merging user options with default values.
        """
        if user_opt is None:
            user_dict = {}
        elif isinstance(user_opt, config):
            user_dict = vars(user_opt)
        elif isinstance(user_opt, dict):
            user_dict = user_opt
        else:
            raise TypeError("user_opt must be dict, config(SimpleNamespace) or None")

        self._validate_keys(user_dict)
        merged = {**self._default_dict, **user_dict}
        return config(**merged)