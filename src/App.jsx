import React, { useEffect, useState } from 'react';

import Navbar from './components/Navbar';
import LandingPage from './components/LandingPage';
import QuizScreen from './components/QuizScreen';
import RoadmapView from './components/RoadmapView';
import WeakAreasView from './components/WeakAreasView';
import DashboardView from './components/DashboardView';
import JudgeDrawer from './components/JudgeDrawer';
import AITutorModal from './components/AITutorModal';

// import { PRESET_SCENARIOS } from './mockData';
import { getMastery, DEMO_USER_ID } from './api';

import { Shield } from 'lucide-react';

// Canonical subdomains match the Neon database. These are UI metadata only;
// mastery scores are loaded from FastAPI and are unknown until assessed.
const DOMAIN_DEFINITIONS = [
  ['Phishing', 'phishing'],
  ['Password Hygiene', 'passwords'],
  ['Social Engineering', 'social_eng'],
  ['Data Handling', 'data_handling'],
  ['Incident Reporting', 'incident_rep'],
];

const DOMAIN_ALIASES = {
  'Phishing Awareness': 'Phishing',
  'Confidential Data Handling': 'Data Handling',
  'Incident Reporting & SLA': 'Incident Reporting',
};

const normalizeDomainName = (name) => DOMAIN_ALIASES[name] || name;

const createInitialDomainState = () => Object.fromEntries(
  DOMAIN_DEFINITIONS.map(([name, id]) => [name, {
    id,
    name,
    p_know: null,
    p_transit: null,
    p_slip: null,
    p_guess: null,
    history: [],
  }])
);

const buildDomainStateFromMastery = (mastery = {}, previousState = {}, preserveHistory = false) => {
  const updated = createInitialDomainState();

  Object.entries(mastery || {}).forEach(([rawDomain, rawScore]) => {
    if (rawScore === null || rawScore === undefined || rawScore === '') return;
    const score = Number(rawScore);
    if (!Number.isFinite(score) || score < 0 || score > 1) return;

    const domain = normalizeDomainName(rawDomain);
    if (!updated[domain]) {
      updated[domain] = {
        id: domain.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        name: domain,
        p_know: null,
        p_transit: null,
        p_slip: null,
        p_guess: null,
        history: [],
      };
    }

    updated[domain] = {
      ...updated[domain],
      p_know: score,
      history: preserveHistory ? (previousState[domain]?.history || []) : [],
    };
  });

  return updated;
};



// ============================================================
// BACKEND CONFIG
// ============================================================



// ============================================================
// APP
// ============================================================

export default function App() {

  const [activeTab, setActiveTab] = useState('home');

  const [domainState, setDomainState] = useState(createInitialDomainState);

  const [masteryStatus, setMasteryStatus] = useState('loading');

  const [masteryError, setMasteryError] = useState('');

  const [attemptHistory, setAttemptHistory] = useState([]);

  const [completedCourses, setCompletedCourses] = useState({});

  const [selectedTopicForRemediation, setSelectedTopicForRemediation] =
    useState(null);

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const [isAITutorOpen, setIsAITutorOpen] = useState(false);

  const [currentScenario, setCurrentScenario] = useState('midLevel');


  // ============================================================
  // LOAD USER MASTERY FROM BACKEND
  // ============================================================

  useEffect(() => {

    loadMastery();

  }, []);


  const loadMastery = async () => {
    setMasteryStatus('loading');
    setMasteryError('');

    try {
      const data = await getMastery(DEMO_USER_ID);
      console.log('Mastery from backend:', data);

      const updated = buildDomainStateFromMastery(data.mastery || {});
      setDomainState(updated);

      const hasScores = Object.values(updated).some(
        (domain) => typeof domain.p_know === 'number' && Number.isFinite(domain.p_know)
      );
      setMasteryStatus(hasScores ? 'ready' : 'unassessed');
    } catch (error) {
      console.error('Failed to load mastery from backend:', error);
      setDomainState(createInitialDomainState());
      setMasteryStatus('error');
      setMasteryError(error.message || 'Could not load mastery from the backend.');
    }
  };

  // ============================================================
  // OVERALL MASTERY
  // ============================================================

  const domainValues = Object.values(domainState);
  const assessedDomainValues = domainValues.filter(
    (domain) => typeof domain.p_know === 'number' && Number.isFinite(domain.p_know)
  );

  const overallMastery = assessedDomainValues.length > 0
    ? Math.round(
        assessedDomainValues.reduce((total, domain) => total + domain.p_know, 0)
        / assessedDomainValues.length * 100
      )
    : null;

  // ============================================================
  // BKT UPDATE
  // ============================================================

  /*
    This function is now intended to receive
    the result returned by FastAPI.

    Example:

    {
      domain: "Phishing",
      mastery: 0.7646,
      attempt: {...}
    }
  */

  const handleBKTUpdate = (
    domainName,
    newMastery,
    attemptDetails,
    allMastery
  ) => {
    const normalizedDomain = normalizeDomainName(domainName);

    setDomainState((prev) => {
      // The complete mastery map comes from FastAPI after assessment. Rebuilding
      // from it also prevents judge-simulation scores from leaking into real state.
      const updated = allMastery
        ? buildDomainStateFromMastery(allMastery, prev, masteryStatus !== 'simulated')
        : { ...prev };

      const base = updated[normalizedDomain] || {
        id: normalizedDomain.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        name: normalizedDomain,
        p_transit: null,
        p_slip: null,
        p_guess: null,
        history: [],
      };
      updated[normalizedDomain] = {
        ...base,
        p_know: newMastery,
        history: [...(base.history || []), newMastery],
      };
      return updated;
    });

    setMasteryStatus('ready');
    setMasteryError('');

    if (attemptDetails) {
      setAttemptHistory((prev) => [...prev, attemptDetails]);
    }
  };

  // ============================================================
  // COURSE COMPLETION
  // ============================================================

  const handleCourseToggle = (
    courseId,
    topicName,
    isDone
  ) => {

    setCompletedCourses(prev => ({

      ...prev,

      [courseId]: isDone

    }));


    /*
      TEMPORARY FRONTEND BEHAVIOUR.

      We are NOT yet treating course completion
      as actual BKT evidence.

      The actual mastery update should come from
      assessment results.

      Therefore, DO NOT add +0.08 here.
    */

  };


  // ============================================================
  // JUDGE SIMULATION
  // ============================================================

  const handleSimulatePass = () => {

    setMasteryStatus('simulated');
    setMasteryError('');

    setDomainState(prev => ({

      ...prev,

      "Social Engineering": {

        ...prev["Social Engineering"],

        p_know: 0.90

      },

      "Data Handling": {

        ...prev["Data Handling"],

        p_know: 0.85

      },

      "Incident Reporting": {

        ...prev["Incident Reporting"],

        p_know: 0.82

      }

    }));

  };


  // ============================================================
  // RESET
  // ============================================================

  const handleResetPath = () => {

    setDomainState(createInitialDomainState());
    setMasteryStatus('loading');

    setCompletedCourses({});

    setAttemptHistory([]);

    loadMastery();

  };


  // ============================================================
  // PRESET SCENARIO
  // ============================================================

  const handleApplyScenario = (scenarioKey) => {

    const scenario =
      PRESET_SCENARIOS[scenarioKey];

    if (!scenario) return;


    setCurrentScenario(scenarioKey);
    setMasteryStatus('simulated');
    setMasteryError('');

    setDomainState(prev => {

      const updated = { ...prev };


      Object.entries(
        scenario.mastery
      ).forEach(([domain, score]) => {

        if (updated[domain]) {

          updated[domain] = {

            ...updated[domain],

            p_know: score

          };

        }

      });


      return updated;

    });

  };


  // ============================================================
  // REMEDIATION NAVIGATION
  // ============================================================

  const handleNavigateToRemediation = (
    topic = null
  ) => {

    setSelectedTopicForRemediation(topic);

    setActiveTab('remediation');

  };


  // ============================================================
  // RENDER
  // ============================================================

  return (

    <div
      className="
        min-h-screen
        bg-slate-950
        text-slate-100
        flex
        flex-col
        selection:bg-cyan-500
        selection:text-slate-950
        font-sans
        antialiased
      "
    >

      {/* ======================================================
          NAVBAR
      ====================================================== */}

      <Navbar

        activeTab={activeTab}

        setActiveTab={setActiveTab}

        onOpenDrawer={() =>
          setIsDrawerOpen(true)
        }

        onOpenAITutor={() =>
          setIsAITutorOpen(true)
        }

        currentScenario={currentScenario}

        onSelectScenario={handleApplyScenario}

        overallMastery={overallMastery}

      />


      {/* ======================================================
          MAIN
      ====================================================== */}

      <main
        className="
          flex-1
          max-w-7xl
          w-full
          mx-auto
          px-4
          sm:px-6
          lg:px-8
          py-6
        "
      >

        {masteryStatus === 'error' && (
          <div className="mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            <span>Could not load saved mastery from the backend. Scores are unavailable, not zero. {masteryError}</span>
            <button onClick={loadMastery} className="shrink-0 rounded-lg border border-rose-700 px-3 py-1.5 font-semibold hover:bg-rose-900/50">Retry</button>
          </div>
        )}

        {masteryStatus === 'unassessed' && (
          <div className="mb-5 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-300">
            No saved mastery scores were found for this learner. Complete the diagnostic quiz to establish a baseline.
          </div>
        )}

        {masteryStatus === 'simulated' && (
          <div className="mb-5 rounded-xl border border-amber-800 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
            Judge simulation active — these mastery values are local demo values and are not saved to Neon. Reset the pathway to reload persisted scores.
          </div>
        )}

        {/* HOME */}

        {activeTab === 'home' && (

          <LandingPage

            setActiveTab={setActiveTab}

            onOpenDrawer={() =>
              setIsDrawerOpen(true)
            }

            onOpenAITutor={() =>
              setIsAITutorOpen(true)
            }

            domains={domainState}

          />

        )}


        {/* QUIZ */}

        {activeTab === 'quiz' && (

          <QuizScreen

            domainState={domainState}

            onBKTUpdate={handleBKTUpdate}

            onOpenDrawer={() =>
              setIsDrawerOpen(true)
            }

            onNavigateToRemediation={
              handleNavigateToRemediation
            }

            onNavigateToRoadmap={() =>
              setActiveTab('roadmap')
            }

          />

        )}


        {/* ROADMAP */}

        {activeTab === 'roadmap' && (

          <RoadmapView

            domainState={domainState}

            onSimulatePass={
              handleSimulatePass
            }

            onResetPath={
              handleResetPath
            }

            onNavigateToQuiz={() =>
              setActiveTab('quiz')
            }

            onNavigateToRemediation={
              handleNavigateToRemediation
            }

          />

        )}


        {/* REMEDIATION */}

        {activeTab === 'remediation' && (

          <WeakAreasView

            domainState={domainState}

            selectedTopic={
              selectedTopicForRemediation
            }

            onCourseToggle={
              handleCourseToggle
            }

            completedCourses={
              completedCourses
            }

            onNavigateToQuiz={() =>
              setActiveTab('quiz')
            }

          />

        )}


        {/* ANALYTICS */}

        {activeTab === 'analytics' && (

          <DashboardView

            domainState={domainState}

            onNavigateToQuiz={() =>
              setActiveTab('quiz')
            }

            onNavigateToRemediation={
              handleNavigateToRemediation
            }

          />

        )}

      </main>


      {/* ======================================================
          JUDGE DRAWER
      ====================================================== */}

      <JudgeDrawer

        isOpen={isDrawerOpen}

        onClose={() =>
          setIsDrawerOpen(false)
        }

        domainState={domainState}

        isSimulated={masteryStatus === 'simulated'}

        onApplyScenario={
          handleApplyScenario
        }

        attemptHistory={
          attemptHistory
        }

      />


      {/* ======================================================
          AI TUTOR
      ====================================================== */}

      <AITutorModal

        isOpen={isAITutorOpen}

        onClose={() =>
          setIsAITutorOpen(false)
        }

      />


      {/* ======================================================
          FOOTER
      ====================================================== */}

      <footer
        className="
          border-t
          border-slate-900
          bg-slate-950
          py-8
          text-slate-500
          text-xs
          mt-auto
        "
      >

        <div
          className="
            max-w-7xl
            mx-auto
            px-4
            sm:px-6
            lg:px-8
            flex
            flex-col
            sm:flex-row
            items-center
            justify-between
            gap-4
          "
        >

          <div className="flex items-center gap-2">

            <div
              className="
                w-6
                h-6
                rounded-lg
                bg-cyan-950
                border
                border-cyan-800
                flex
                items-center
                justify-center
                text-cyan-400
              "
            >

              <Shield className="w-3.5 h-3.5" />

            </div>

            <span className="font-bold text-slate-300">
              AdaptIQ
            </span>

            <span>
              • SIH1409 (Smart India Hackathon 2026)
            </span>

          </div>


          <div
            className="
              flex
              items-center
              gap-4
              text-[11px]
            "
          >

            <button
              onClick={() =>
                setIsDrawerOpen(true)
              }
              className="hover:text-cyan-400 transition"
            >
              ⚙️ BKT Inspector
            </button>

            <span>•</span>

            <button
              onClick={() =>
                setIsAITutorOpen(true)
              }
              className="hover:text-indigo-400 transition"
            >
              🤖 AI Knowledge Coach
            </button>

            <span>•</span>

            <button
              onClick={() =>
                setActiveTab('home')
              }
              className="hover:text-white transition"
            >
              Home
            </button>

          </div>

        </div>

      </footer>

    </div>

  );

}