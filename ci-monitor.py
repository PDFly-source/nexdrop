import os, sys, time, json, requests
run_id, prefix = sys.argv[1], sys.argv[2]
s = requests.Session(); s.headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_ACCESS_TOKEN']
base = 'https://api.github.com/repos/PDFly-source/nexdrop'
last = None
for attempt in range(110):
    r = s.get(base + '/actions/runs/' + run_id, timeout=30); r.raise_for_status()
    run = r.json()
    cur = (run['status'], run['conclusion'])
    if cur != last:
        print('RUN', run['id'], cur, flush=True); last = cur
    if run['status'] == 'completed':
        jobs = s.get(base + '/actions/runs/' + run_id + '/jobs', timeout=30); jobs.raise_for_status()
        result = {'run': run, 'jobs': jobs.json()['jobs']}
        json.dump(result, open(prefix + '.json', 'w'), indent=2)
        for job in result['jobs']:
            print('JOB', job['name'], job['conclusion'], flush=True)
            for step in job['steps']:
                print('  STEP', step['name'], step['conclusion'], flush=True)
        print('DONE', run['conclusion'], flush=True)
        sys.exit(0 if run['conclusion'] == 'success' else 1)
    time.sleep(30)
raise TimeoutError('CI not finished in 55 minutes')
