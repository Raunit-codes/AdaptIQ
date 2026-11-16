import React, { useEffect, useState } from 'react';
import { getNextQuiz, submitAssessment, DEMO_USER_ID } from '../api';
import { CheckCircle, XCircle, Sparkles, Sliders, ArrowRight, BookOpen, RotateCcw, AlertTriangle, HelpCircle } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function QuizScreen({ 
  domainState, 
  onBKTUpdate, 
  onOpenDrawer, 
  onNavigateToRemediation,
  onNavigateToRoadmap 
}) {
  const [quizQuestions, setQuizQuestions] = useState([]);
  const [loadingQuiz, setLoadingQuiz] = useState(true);
  const [quizError, setQuizError] = useState('');
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState(null);
  const [confidence, setConfidence] = useState(70);
  const [submitted, setSubmitted] = useState(false);
  const [explanationType, setExplanationType] = useState('simple');
  const [lastBKTResult, setLastBKTResult] = useState(null);
  const [quizHistory, setQuizHistory] = useState([]);

  const currentQ = quizQuestions[currentQuestionIndex];
  const currentDomainData = domainState[currentQ?.subDomain] || { p_know: null, p_slip: null, p_guess: null, p_transit: null };
  const hasCurrentMastery = typeof currentDomainData.p_know === 'number' && Number.isFinite(currentDomainData.p_know);

  const loadAdaptiveQuiz = async () => {
    setLoadingQuiz(true);
    setQuizError('');
    try {
      const data = await getNextQuiz(DEMO_USER_ID);
      const questions = (data.quiz || []).map((q) => {
        let rawOptions = q.options;
        if (typeof rawOptions === 'string') {
          try { rawOptions = JSON.parse(rawOptions); }
          catch { rawOptions = rawOptions.split(';').map((item) => item.trim()).filter(Boolean); }
        }
        return {
          id: q.question_id,
          subDomain: q.subdomain,
          question: q.question_text,
          difficulty: Number(q.difficulty) <= 2 ? 'Easy' : Number(q.difficulty) <= 3 ? 'Medium' : 'Hard',
          options: (rawOptions || []).map((option, index) => ({
            id: String.fromCharCode(65 + index),
            text: typeof option === 'string' ? option : String(option.text ?? option.label ?? option),
            correct: false,
          })),
          explanations: {
            simple: 'Review the scenario and the correct answer to reinforce this cybersecurity concept.',
            tech: 'Use the correct response and the associated subdomain to guide further practice.',
          },
        };
      });
      setQuizQuestions(questions);
      setCurrentQuestionIndex(0);
      setSelectedOption(null);
      setSubmitted(false);
      setLastBKTResult(null);
      if (!questions.length) setQuizError('The backend did not return any available questions.');
    } catch (error) {
      console.error('Failed to load adaptive quiz:', error);
      setQuizError(error.message || 'Could not load quiz from backend.');
    } finally {
      setLoadingQuiz(false);
    }
  };

  useEffect(() => { loadAdaptiveQuiz(); }, []);

  const handleOptionSelect = (optionId) => {
    if (!submitted) {
      setSelectedOption(optionId);
    }
  };

  const handleSubmit = async () => {
    if (!selectedOption) return;

    const chosen = currentQ.options.find(
      o => o.id === selectedOption
    );

    if (!chosen) return;

    try {
      const data = await submitAssessment({
        user_id: DEMO_USER_ID,
        new_attempts: [{
          question_id: currentQ.id,
          answer: chosen.text,
        }],
      });
      const result = data.results?.find((item) => item.question_id === currentQ.id);
      const correct = Boolean(result?.correct);
      setQuizQuestions((prev) => prev.map((question) => question.id !== currentQ.id ? question : ({
        ...question,
        options: question.options.map((option) => ({
          ...option,
          correct: option.text === result?.correct_answer,
        })),
      })));

      console.log('Backend BKT result:', data);

      const isAnswerCorrect = correct;
      const newMastery = data.mastery[currentQ.subDomain];

      if (newMastery !== undefined) {
        onBKTUpdate(
          currentQ.subDomain,
          newMastery,
          {
            questionId: currentQ.id,
            questionText: currentQ.question,
            subDomain: currentQ.subDomain,
            isCorrect: isAnswerCorrect,
            confidence,
            timestamp: new Date().toLocaleTimeString(),
          },
          data.mastery
        );

        const previousMastery = hasCurrentMastery ? currentDomainData.p_know : null;
        setLastBKTResult({
          prior: previousMastery,
          updatedMastery: newMastery,
          scorePercent: Math.round(newMastery * 100),
          delta: previousMastery === null ? null : newMastery - previousMastery,
        });
      }

      setSubmitted(true);

      setQuizHistory(prev => [
        ...prev,
        {
          id: currentQ.id,
          subDomain: currentQ.subDomain,
          isCorrect: isAnswerCorrect,
          delta: newMastery !== undefined && hasCurrentMastery
            ? newMastery - currentDomainData.p_know
            : null,
        },
      ]);

      if (isAnswerCorrect && newMastery > 0.85) {
        confetti({
          particleCount: 40,
          spread: 60,
          origin: { y: 0.8 },
        });
      }

    } catch (error) {
      console.error('Assessment failed:', error);
      alert(`Could not submit assessment: ${error.message || 'backend request failed'}`);
    }
  };

  const handleNextAdaptiveQuestion = async () => {
    if (currentQuestionIndex + 1 < quizQuestions.length) {
      setCurrentQuestionIndex((index) => index + 1);
      setSelectedOption(null);
      setSubmitted(false);
      setLastBKTResult(null);
      setConfidence(70);
      return;
    }
    await loadAdaptiveQuiz();
  };

  const handleSelectQuestionDirectly = (idx) => {
    setCurrentQuestionIndex(idx);
    setSelectedOption(null);
    setSubmitted(false);
    setLastBKTResult(null);
    setConfidence(70);
  };

  const isSelectedCorrect = Boolean(submitted && currentQ?.options.find(o => o.id === selectedOption)?.correct);

  if (loadingQuiz) return <div className="max-w-4xl mx-auto py-12 text-center text-cyan-300">Loading adaptive quiz from backend…</div>;
  if (quizError || !currentQ) return <div className="max-w-4xl mx-auto py-12 space-y-4 text-center"><p className="text-rose-300">{quizError || 'No questions available.'}</p><button onClick={loadAdaptiveQuiz} className="px-4 py-2 rounded-lg bg-cyan-500 text-slate-950 font-bold">Retry</button></div>;

  return (
    <div className="max-w-4xl mx-auto py-4 space-y-6">
      
      {/* Top Breadcrumb & Question Stepper */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900 border border-slate-800 p-4 rounded-2xl">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-cyan-950 text-cyan-400 border border-cyan-800">
              Adaptive Assessment Loop
            </span>
            <span className="text-xs text-slate-400">
              Question {currentQuestionIndex + 1} of {quizQuestions.length}
            </span>
          </div>
          <div className="text-sm font-semibold text-white mt-1 flex items-center gap-2">
            Target Domain: <span className="text-cyan-400">{currentQ.subDomain}</span>
          </div>
        </div>

        {/* Question Selector Quick Dots */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {quizQuestions.map((q, idx) => {
            const isCurrent = idx === currentQuestionIndex;
            const historyItem = quizHistory.find(h => h.id === q.id);
            return (
              <button
                key={q.id}
                onClick={() => handleSelectQuestionDirectly(idx)}
                className={`w-8 h-8 rounded-lg text-xs font-mono font-bold flex items-center justify-center transition-all ${
                  isCurrent
                    ? 'bg-cyan-500 text-slate-950 ring-2 ring-cyan-400 shadow-md shadow-cyan-500/30'
                    : historyItem
                    ? historyItem.isCorrect
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                      : 'bg-rose-950 text-rose-300 border border-rose-700'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white border border-slate-700'
                }`}
                title={`Q${idx + 1}: ${q.subDomain}`}
              >
                {idx + 1}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Question Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6 relative overflow-hidden">
        
        {/* Domain & Difficulty Tags */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold px-3 py-1 rounded-lg bg-slate-800 text-slate-200 border border-slate-700">
              📂 {currentQ.subDomain}
            </span>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg border ${
              currentQ.difficulty === 'Easy'
                ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                : currentQ.difficulty === 'Medium'
                ? 'bg-amber-950 text-amber-300 border-amber-800'
                : 'bg-rose-950 text-rose-300 border-rose-800'
            }`}>
              Difficulty: {currentQ.difficulty}
            </span>
          </div>

          <button
            onClick={onOpenDrawer}
            className="text-xs font-semibold text-cyan-400 hover:text-cyan-300 flex items-center gap-1.5 bg-slate-800/80 hover:bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700 transition"
          >
            <Sliders className="w-3.5 h-3.5 text-cyan-400" />
            Live BKT: {hasCurrentMastery ? `${Math.round(currentDomainData.p_know * 100)}% Mastery` : 'Not assessed'}
          </button>
        </div>

        {/* Question Text */}
        <h2 className="text-xl sm:text-2xl font-bold text-white leading-relaxed">
          {currentQ.question}
        </h2>

        {/* Options List */}
        <div className="space-y-3">
          {currentQ.options.map((option) => {
            const isSelected = selectedOption === option.id;
            let optionStyles = 'bg-slate-950/70 border-slate-800 text-slate-300 hover:bg-slate-800 hover:border-slate-700';

            if (isSelected && !submitted) {
              optionStyles = 'bg-cyan-950/80 border-cyan-500 text-white shadow-md shadow-cyan-950 ring-1 ring-cyan-500';
            } else if (submitted) {
              if (option.correct) {
                optionStyles = 'bg-emerald-950/80 border-emerald-500 text-emerald-200 shadow-md shadow-emerald-950 ring-1 ring-emerald-500';
              } else if (isSelected && !option.correct) {
                optionStyles = 'bg-rose-950/80 border-rose-500 text-rose-200 shadow-md shadow-rose-950 ring-1 ring-rose-500';
              } else {
                optionStyles = 'bg-slate-950/40 border-slate-900 text-slate-500 opacity-60';
              }
            }

            return (
              <button
                key={option.id}
                onClick={() => handleOptionSelect(option.id)}
                disabled={submitted}
                className={`w-full text-left p-4 rounded-xl border transition-all flex items-start gap-3.5 cursor-pointer ${optionStyles}`}
              >
                <div className={`w-6 h-6 rounded-lg text-xs font-bold uppercase flex items-center justify-center shrink-0 mt-0.5 ${
                  isSelected 
                    ? submitted 
                      ? option.correct 
                        ? 'bg-emerald-500 text-slate-950' 
                        : 'bg-rose-500 text-slate-950'
                      : 'bg-cyan-500 text-slate-950'
                    : 'bg-slate-800 text-slate-400'
                }`}>
                  {option.id}
                </div>
                <span className="text-sm font-medium leading-normal flex-1">{option.text}</span>
                {submitted && option.correct && (
                  <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                )}
                {submitted && isSelected && !option.correct && (
                  <XCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                )}
              </button>
            );
          })}
        </div>

        {/* Confidence Calibration Slider */}
        <div className="p-4 bg-slate-950/90 rounded-2xl border border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              Self-Reported Confidence Level:
            </span>
            <span className={`font-mono font-bold px-2 py-0.5 rounded ${
              confidence >= 80 ? 'text-emerald-400 bg-emerald-950' : confidence >= 50 ? 'text-cyan-400 bg-cyan-950' : 'text-amber-400 bg-amber-950'
            }`}>
              {confidence}% ({confidence >= 80 ? 'High Certainty' : confidence >= 50 ? 'Moderate' : 'Tentative Guess'})
            </span>
          </div>

          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={confidence}
            onChange={(e) => setConfidence(Number(e.target.value))}
            disabled={submitted}
            className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />

          <div className="flex justify-between text-[10px] text-slate-500">
            <span>0% (Blind Guess)</span>
            <span>50% (Reasonable Assumption)</span>
            <span>100% (Absolute Certainty)</span>
          </div>
        </div>

        {/* Action Button */}
        {!submitted ? (
          <button
            onClick={handleSubmit}
            disabled={!selectedOption}
            className="w-full py-3.5 rounded-xl font-bold text-sm bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 shadow-lg shadow-cyan-500/20 transition cursor-pointer"
          >
            Submit Answer & Compute BKT Mastery
          </button>
        ) : (
          /* Post Submission Feedback & Remediation */
          <div className="space-y-5 pt-2">
            
            {/* Live BKT Delta Result Banner */}
            {lastBKTResult && (
              <div className={`p-4 rounded-2xl border flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                isSelectedCorrect 
                  ? 'bg-emerald-950/40 border-emerald-600/50 text-emerald-200' 
                  : 'bg-rose-950/40 border-rose-600/50 text-rose-200'
              }`}>
                <div className="flex items-center gap-3">
                  {isSelectedCorrect ? (
                    <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
                      <CheckCircle className="w-6 h-6" />
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 shrink-0">
                      <XCircle className="w-6 h-6" />
                    </div>
                  )}
                  <div>
                    <h4 className="font-bold text-sm">
                      {isSelectedCorrect ? 'Correct Assessment Response!' : 'Misconception Detected'}
                    </h4>
                    <p className="text-xs opacity-80 mt-0.5">
                      {lastBKTResult.prior === null
                        ? <>Initial mastery estimate: <strong>{lastBKTResult.scorePercent}%</strong></>
                        : <>Previous mastery {Math.round(lastBKTResult.prior * 100)}% → updated to <strong>{lastBKTResult.scorePercent}%</strong></>}
                    </p>
                  </div>
                </div>

                {lastBKTResult.delta !== null && (
                  <div className="flex items-center gap-2 font-mono text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-950/80 border border-slate-800 shrink-0">
                    <span>Delta:</span>
                    <span className={lastBKTResult.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {lastBKTResult.delta >= 0 ? `+${Math.round(lastBKTResult.delta * 100)}%` : `${Math.round(lastBKTResult.delta * 100)}%`}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Explainable AI Dual Tabs */}
            <div className="bg-slate-950 p-5 rounded-2xl border border-slate-800 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                  Explainable AI Learning Insights:
                </span>
                <div className="flex items-center bg-slate-900 p-0.5 rounded-lg border border-slate-800">
                  <button
                    onClick={() => setExplanationType('simple')}
                    className={`px-3 py-1 text-xs rounded-md font-medium transition ${
                      explanationType === 'simple' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    👶 Simple (Non-Tech)
                  </button>
                  <button
                    onClick={() => setExplanationType('tech')}
                    className={`px-3 py-1 text-xs rounded-md font-medium transition ${
                      explanationType === 'tech' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    🛡️ Technical (Cyber Pro)
                  </button>
                </div>
              </div>

              <p className="text-sm text-slate-300 leading-relaxed">
                {currentQ.explanations?.[explanationType] || currentQ.explanations?.simple}
              </p>
            </div>

            {/* Post Quiz Navigation Actions */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
              <button
                onClick={handleNextAdaptiveQuestion}
                className="py-3 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-md shadow-cyan-500/20"
              >
                Next Adaptive Question <ArrowRight className="w-4 h-4" />
              </button>

              <button
                onClick={() => onNavigateToRemediation(currentQ.subDomain)}
                className="py-3 px-4 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <BookOpen className="w-4 h-4" />
                Targeted Courses ({currentQ.subDomain})
              </button>

              <button
                onClick={onNavigateToRoadmap}
                className="py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
              >
                View Skill Tree Progress
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}