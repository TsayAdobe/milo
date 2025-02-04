import {
  PROCESS_TYPES,
  getErrorText,
  getAemUrl,
  delay,
  frisk,
  isDelete,
} from './utils.js';

const BASE_URL = 'https://admin.hlx.page';
const headers = { 'Content-Type': 'application/json' };

const isLive = (type) => ['publish', 'unpublish'].includes(type);
const getProcessAlias = (type) => {
  if (type === 'index') return type;
  if (isLive(type)) return 'live';
  return 'preview';
};

const getEndpoint = (url, type, usePath = false) => {
  const [ref, repo, owner] = getAemUrl(url);
  const process = getProcessAlias(type);
  const path = usePath ? url.pathname : '/*';
  return `${BASE_URL}/${process}/${owner}/${repo}/${ref}${path}`;
};

const getRequest = (url, process, useBulk = true) => {
  const useDelete = isDelete(process);
  const href = useBulk ? [url.href] : url.href;
  const endpoint = getEndpoint(url, process, !useBulk);
  const options = { headers, method: useDelete ? 'DELETE' : 'POST', body: {} };
  if (useBulk) options.body = { paths: [] };
  return {
    href,
    options,
    path: url.pathname,
    origin: url.origin,
    endpoint,
  };
};

const setUserData = (event) => {
  const processes = event?.detail?.data;
  if (processes) {
    const profile = processes.profile ?? null;
    const permissions = {};
    PROCESS_TYPES.forEach((key) => {
      if (key !== 'index') {
        const process = isLive(key) ? 'live' : 'preview';
        const userPermissions = processes[process]?.permissions;
        permissions[key] = {
          useBulk: frisk(userPermissions, 'list'),
          canUse: frisk(userPermissions, 'write'),
        };
      }
    });
    return { profile, permissions };
  }
  return null;
};

const isPushedDown = async () => {
  const callback = () => {
    const sidekick = document.querySelector('helix-sidekick');
    const pushdown = sidekick?.getAttribute('pushdown');
    const bulkPub = document.querySelector('.bulk-publish-v2');
    if (pushdown && !bulkPub.classList.contains('pushdown')) {
      bulkPub.classList.add('pushdown');
    }
  };
  const observer = new MutationObserver(callback);
  observer.observe(document, {
    attributes: true,
    subtree: true,
    attributeOldValue: true,
  });
};

const authenticate = async (tool = null) => {
  isPushedDown();
  const setUser = (event) => { tool.user = setUserData(event); };
  const openSideKick = document.querySelector('helix-sidekick');
  if (openSideKick) {
    openSideKick.addEventListener('statusfetched', setUser);
    /* c8 ignore next 6 */
  } else {
    document.addEventListener('sidekick-ready', () => {
      const sidekick = document.querySelector('helix-sidekick');
      sidekick.addEventListener('statusfetched', setUser);
    }, { once: true });
  }
};

const mapJobList = ({ urls, process }) => {
  const all = urls.map((url) => (new URL(url)));
  return all.map((url) => (getRequest(url, process, false)));
};

const prepareJobs = (details, useBulk) => {
  if (!useBulk) return mapJobList(details);
  const { urls, process } = details;
  const paths = urls.map((url) => (new URL(url)));
  return Object.values(paths.reduce((jobs, url) => {
    let base = url.host;
    // groups of 100 for users without 'list' permissions
    /* c8 ignore next 3 */
    while (!details.useBulk && jobs[base]?.options.body.paths.length >= 100) {
      base = `${base}+`;
    }
    if (!jobs[base]) jobs[base] = getRequest(url, process);
    const job = jobs[base];
    if (isDelete(process)) {
      const param = job.endpoint.includes('?') ? '&' : '?';
      job.endpoint = `${job.endpoint}${param}paths[]=${url.pathname}`;
    } else {
      job.options.body.paths.push(url.pathname.toLowerCase());
    }
    job.href.push(url.href);
    return jobs;
  }, {}));
};

const formatResult = ({ status }, job) => {
  const paths = job.urls.map((url) => (new URL(url).pathname));
  const stopTime = new Date();
  return {
    job: {
      stopTime,
      topic: job.process,
      state: 'stopped',
      name: `job-${stopTime.toISOString()}`,
      data: { paths, resources: paths.map((path) => ({ path, status })) },
      progress: { failed: [200, 204].includes(status) ? 0 : 1 },
    },
  };
};

const startJob = async (details) => {
  const { process } = details;
  // index is the only process missing bulk endpoint
  const useBulk = process !== 'index';
  const jobs = prepareJobs(details, useBulk);
  const requests = jobs.flatMap(async (job) => {
    const { options, origin, endpoint } = job;
    if (!isDelete(process)) options.body.forceUpdate = true;
    options.body = JSON.stringify(options.body);
    try {
      const request = await fetch(endpoint, options);
      if (!request.ok && useBulk) {
        throw new Error(getErrorText(request.status), request, origin);
      }
      const result = useBulk ? await request.json() : formatResult(request, details);
      return { ...job, result, useBulk };
    } catch (error) {
      return {
        ...job,
        error: error.status ?? 400,
        message: error.message,
      };
    }
  });
  const results = await Promise.all(requests);
  return results;
};

const getJobStatus = async (link) => {
  await delay();
  try {
    const status = await fetch(link, { headers });
    const result = await status.json();
    return result;
  /* c8 ignore next 3 */
  } catch (error) {
    return error;
  }
};

const pollJobStatus = async (job, setProgress) => {
  const { result } = job;
  let jobStatus;
  let stopped = false;
  while (!stopped) {
    const status = await getJobStatus(`${result.links.self}/details`);
    if (status.stopTime) {
      jobStatus = status;
      stopped = true;
    }
    setProgress(status);
  }
  return jobStatus;
};

const updateRetry = async ({ queue, urls, process }) => {
  const jobs = mapJobList({ urls, process });
  const processes = jobs.flatMap(async ({ endpoint, options, origin, href }) => {
    try {
      await delay();
      options.body = JSON.stringify(options.body);
      const job = await fetch(endpoint, options);
      /* c8 ignore next 3 */
      if (!job.ok) {
        throw new Error(getErrorText(job.status), { cause: job.status }, origin);
      }
      const result = await job.json();
      return { href, origin, result };
    /* c8 ignore next 3 */
    } catch (error) {
      return { href, origin, result: { status: error.cause } };
    }
  });
  const statuses = await Promise.all(processes);
  const newQueue = queue.map((entry, index) => {
    const { result } = statuses.find((stat) => stat.href === urls[index]);
    const status = (result?.[getProcessAlias(process)]?.status || result?.status) ?? entry.status;
    return { ...entry, status, count: entry.count + 1 };
  });
  return newQueue;
};

export {
  authenticate,
  pollJobStatus,
  startJob,
  updateRetry,
};
