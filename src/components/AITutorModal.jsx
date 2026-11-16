import React, { useState } from 'react';
import { Bot, X, Sparkles, Send, User, BookOpen, Lightbulb, ExternalLink } from 'lucide-react';
import { askAITutor } from '../api';

function TutorAnswerView({ answer }) {
  if (!answer || typeof answer !== 'object') {
    return <p className="whitespace-pre-wrap">{String(answer || 'The tutor returned an empty response.')}</p>;
  }

  return (
    <div className="space-y-4">
      {answer.direct_answer && (
        <p className="text-sm leading-6 text-slate-100">{answer.direct_answer}</p>
      )}

      {Array.isArray(answer.sections) && answer.sections.map((section, index) => (
        <section key={`${section.heading || 'section'}-${index}`} className="space-y-2">
          {section.heading && (
            <h4 className="font-semibold text-cyan-300 text-sm">{section.heading}</h4>
          )}
          {Array.isArray(section.paragraphs) && section.paragraphs.map((paragraph, pIndex) => (
            <p key={pIndex} className="text-sm leading-6 text-slate-300">{paragraph}</p>
          ))}
          {Array.isArray(section.bullets) && section.bullets.length > 0 && (
            <ul className="list-disc pl-5 space-y-1.5 text-sm leading-6 text-slate-300">
              {section.bullets.map((bullet, bIndex) => <li key={bIndex}>{bullet}</li>)}
            </ul>
          )}
        </section>
      ))}

      {Array.isArray(answer.key_takeaways) && answer.key_takeaways.length > 0 && (
        <div className="rounded-xl border border-cyan-900/70 bg-cyan-950/30 p-3">
          <h4 className="flex items-center gap-2 font-semibold text-cyan-300 text-xs uppercase tracking-wide mb-2">
            <Lightbulb className="w-4 h-4" /> Key takeaways
          </h4>
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-200">
            {answer.key_takeaways.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        </div>
      )}

      {Array.isArray(answer.sources) && answer.sources.length > 0 && (
        <div className="border-t border-slate-800 pt-3">
          <h4 className="flex items-center gap-2 text-xs font-semibold text-slate-400 mb-2">
            <BookOpen className="w-4 h-4" /> Sources
          </h4>
          <ul className="space-y-2">
            {answer.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                {source.url && /^https?:\/\//i.test(source.url) ? (
                  <a href={source.url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-cyan-300 hover:text-cyan-200 underline underline-offset-2">
                    {source.title || source.url} <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : (
                  <span className="text-xs text-slate-400">{source.title}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function AITutorModal({ isOpen, onClose }) {
  const [messages, setMessages] = useState([
    {
      sender: 'ai',
      answer: {
        direct_answer: 'Hello! I am the AdaptIQ Knowledge Coach. Ask me about cybersecurity, best practices, or Bayesian Knowledge Tracing (BKT). I can search the web when current or source-backed information is needed.',
        sections: [],
        key_takeaways: [],
        sources: []
      },
      timestamp: 'Just now',
      isWelcome: true
    }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  if (!isOpen) return null;

  const quickPrompts = [
    'Explain Pretexting vs Phishing in simple words',
    'How does BKT calculate lucky guesses and careless slips?',
    'What is the Golden Hour in incident response?',
    'Why does FIDO2 hardware MFA stop reverse proxy phishing?'
  ];

  const handleSend = async (textToSend) => {
    const text = (textToSend ?? inputValue).trim();
    if (!text || isTyping) return;

    const userMsg = {
      sender: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const history = messages
      .filter((message) => !message.isWelcome)
      .slice(-10)
      .map((message) => ({
        role: message.sender === 'user' ? 'user' : 'assistant',
        content: message.sender === 'user' ? message.text : JSON.stringify(message.answer)
      }));

    setMessages((prev) => [...prev, userMsg]);
    setInputValue('');
    setIsTyping(true);

    try {
      const response = await askAITutor([...history, { role: 'user', content: text }]);
      setMessages((prev) => [...prev, {
        sender: 'ai',
        answer: response.answer,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    } catch (error) {
      console.error('AI tutor request failed:', error);
      setMessages((prev) => [...prev, {
        sender: 'ai',
        answer: { direct_answer: `I couldn't reach the AI tutor. ${error.message || 'Check that FastAPI is running and the API keys are configured in the backend .env file.'}` },
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isError: true
      }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-2xl w-full h-[600px] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
        <div className="p-4 sm:p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-950 border border-indigo-700/60 flex items-center justify-center text-indigo-400">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                AdaptIQ Knowledge Coach
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800">Explainable AI</span>
              </h3>
              <p className="text-[11px] text-slate-400">Interactive Cybersecurity &amp; BKT Learning Assistant</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close tutor" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 p-4 sm:p-6 overflow-y-auto space-y-4">
          {messages.map((msg, index) => (
            <div key={index} className={`flex gap-3 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.sender === 'ai' && (
                <div className="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-800 flex items-center justify-center text-indigo-400 shrink-0 mt-0.5">
                  <Bot className="w-4 h-4" />
                </div>
              )}
              <div className={`max-w-[85%] min-w-0 p-4 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                msg.sender === 'user'
                  ? 'bg-cyan-600 text-slate-950 font-medium rounded-tr-none'
                  : msg.isError
                    ? 'bg-rose-950/50 border border-rose-800 text-rose-200 rounded-tl-none shadow-md'
                    : 'bg-slate-950 border border-slate-800 text-slate-200 rounded-tl-none shadow-md'
              }`}>
                {msg.sender === 'user' ? <p className="whitespace-pre-wrap">{msg.text}</p> : <TutorAnswerView answer={msg.answer} />}
                <span className="block text-[10px] opacity-60 mt-3 text-right">{msg.timestamp}</span>
              </div>
              {msg.sender === 'user' && (
                <div className="w-8 h-8 rounded-lg bg-cyan-950 border border-cyan-800 flex items-center justify-center text-cyan-400 shrink-0 mt-0.5">
                  <User className="w-4 h-4" />
                </div>
              )}
            </div>
          ))}
          {isTyping && (
            <div className="flex items-center gap-2 text-xs text-slate-500 font-mono italic">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400 animate-spin" /> AdaptIQ Coach is analyzing...
            </div>
          )}
        </div>

        <div className="px-4 py-2 bg-slate-950/60 border-t border-slate-800/80 flex gap-1.5 overflow-x-auto no-scrollbar">
          {quickPrompts.map((prompt, index) => (
            <button key={index} onClick={() => handleSend(prompt)} disabled={isTyping}
              className="px-2.5 py-1 rounded-lg text-[11px] bg-slate-900 hover:bg-slate-850 disabled:opacity-50 text-slate-300 border border-slate-800 whitespace-nowrap transition cursor-pointer">
              💡 {prompt}
            </button>
          ))}
        </div>

        <form onSubmit={(event) => { event.preventDefault(); handleSend(); }}
          className="p-3 sm:p-4 bg-slate-950 border-t border-slate-800 flex items-center gap-2">
          <input type="text" placeholder="Ask anything (e.g. How does BKT model guess probability?)..."
            value={inputValue} onChange={(event) => setInputValue(event.target.value)}
            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500" />
          <button type="submit" disabled={!inputValue.trim() || isTyping}
            className="p-2.5 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-slate-950 font-bold rounded-xl transition cursor-pointer" aria-label="Send message">
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
