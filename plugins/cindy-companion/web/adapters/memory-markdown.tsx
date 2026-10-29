// Read-only memory Markdown: original renderer uses these same libraries and chat prose tokens.
// Chat-only video, filesystem, streaming and tool-card handlers are outside a settings document.
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '../bridge';
import { toast } from '../../vendor/renderer/lib/toast';
export function MarkdownRenderer({ content, className = '' }: { content: string; className?: string; [key: string]: unknown }) {
  return <div className={`markdown-content ${className}`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href) void invoke('paseo.openExternal', { url: href }).catch(error=>toast.error(error instanceof Error?error.message:String(error))); }}>{children}</a> }}>{content}</ReactMarkdown></div>;
}
