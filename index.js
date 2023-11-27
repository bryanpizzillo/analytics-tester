import { createWriteStream, readFileSync } from 'fs';
import got from 'got'
import meow from 'meow';
import path from 'path';
import puppeteer from 'puppeteer';
import pMap from 'p-map';

const LAUNCH_REGEX = /^https\:\/\/assets\.adobedtm\.com\/(?<launchOrgId>[0-9a-f]{12})\/(?<launchPropertyId>[0-9a-f]{12})\/launch-(?<launchEnvironmentId>[0-9a-f]{12})(?<launchTier>-development|-staging|)(?<launchMinFlag>\.min|)\.js/;
const LAUNCH_DTM_REGEX = /^https\:\/\/assets\.adobedtm\.com\/[0-9a-f]{40}\/satelliteLib-[0-9a-f]{40}\.js/;
const LAUNCH_DTM_LAUNCH_REGEX = /https\:\/\/assets\.adobedtm\.com\/(?<launchOrgId>[0-9a-f]{12})\/(?<launchPropertyId>[0-9a-f]{12})\/launch-(?<launchEnvironmentId>[0-9a-f]{12})(?<launchTier>-development|-staging|)(?<launchMinFlag>\.min|)\.js/;
const DAP_REGEX = /^https\:\/\/dap\.digitalgov\.gov\/Universal-Federated-Analytics-Min\.js/;
const ADOBE_LAUNCH_ANALYTICS_REGEX = /^https\:\/\/assets\.adobedtm\.com\/extensions\/[^\/]+\/AppMeasurement(\.min|)\.js/;
const STATIC_ANALYTICS_REGEX = /^https\:\/\/static\.cancer\.gov\/webanalytics\/s_code\.js/;
const SELF_HOSTED_ANALYTICS_REGEX = /s_code\.js/;

/**
 * Gets all the loaded scripts from a URL.
 *
 * @param {*} url 
 * @returns 
 */
const getScriptsFromPage = async (url) => {

  // @todo: need to find a way to check if there was a redirect.
  // maybe a redirect to another site?

  // Launch the browser and open a new blank page
  const browser = await puppeteer.launch({ headless: 'new' });
  
  try {
    const page = await browser.newPage();

    // Navigate the page to a URL; wait until there have been no
    // more than 2 network requests for the last 500ms. This should
    // allow additional scripts to run.
    const response = await page.goto(url, {
      waitUntil: "networkidle2",
    });

    const redirects = response.request().redirectChain().map(
      chain => chain.response()?.headers()['location']
    );

    const scripts = await page.evaluate(() => {
      return Array.from(document.scripts).filter(script => script.src).map(script => script.src);
    });

    return {
      requestedUrl: url,
      finalUrl: redirects.length > 0 ? redirects[redirects.length-1] : url,
      scripts,
    }
  } finally {
    // Wow, I get to use a finally in JS??
    // So basically the browser should be closed if everything works or if an error is
    // thrown while fetching a page.
    await browser.close();
  }
};

/**
 * Gets the Adobe Tags (aka Launch) information.
 * 
 * This returns the first matching script, although there should never
 * be more than one.
 *
 * @param {string[]} scripts 
 * @returns 
 */
const getLaunchInfo = async (scripts) => {

  // Test for launch
  const launchScript = scripts.find(s => s.match(LAUNCH_REGEX));
  if (launchScript) {
    const match = launchScript.match(LAUNCH_REGEX);
    return {
      launchOrgId: match.groups['launchOrgId'],
      launchPropertyId: match.groups['launchPropertyId'],
      launchEnvironmentId: match.groups['launchEnvironmentId'],
      // It looks like the environments control if it is production or not,
      // but there is the publishing flow, so IDK if this is 100% accurate.
      launchIsProduction: match.groups['launchTier'] === '',
      launchIsMinified: match.groups['launchMinFlag'] === '.min',
      launchIsLegacyDTM: false,
    };
  }

  // Test for legacy DTM
  const dtmScript = scripts.find(s => s.match(LAUNCH_DTM_REGEX));
  if (dtmScript) {

    // This is an old DTM url. So you need to fetch the src contents as
    // text. The first line looks like it has the org, property and env
    // ids in a comment.
    try {
      const scriptText = await got(dtmScript).text();

      const scriptMatch = scriptText.match(LAUNCH_DTM_LAUNCH_REGEX);

      if (scriptMatch) {
        return {
          launchOrgId: scriptMatch.groups['launchOrgId'],
          launchPropertyId: scriptMatch.groups['launchPropertyId'],
          launchEnvironmentId: scriptMatch.groups['launchEnvironmentId'],
          // Given this Launch property was loaded via DTM and that we got
          // the launch info from a comment, the is production and is min
          // items should just be null.
          launchIsProduction: null,
          launchIsMinified: null,
          launchIsLegacyDTM: true,
        };
      } else {
        throw new Error(`Site ${url} loads DTM, but unable to match.`);
      }
    } catch (err) {
      console.error(`Could not get DTM information from ${dtmScript}`);
      console.error(err);
      throw new Error(`Could not get DTM information from ${dtmScript}`);      
    }
  }

  // This site has no launch.
  return {
    launchOrgId: null,
    launchPropertyId: null,
    launchEnvironmentId: null,
    launchIsProduction: null,
    launchIsMinified: null,
  };
};

/**
 * Determines if the site has DAP loaded.
 *
 * @param {*} scripts 
 * @returns 
 */
const hasDap = (scripts) => {
  return scripts.some(script => script.match(DAP_REGEX));
};

/**
 * Gets the agency and subagency from the DAP scripts.
 * 
 * @param {*} scripts 
 * @returns 
 */
const getDapInfo = (scripts) => {
  for (const script of scripts) {
    if (script.match(DAP_REGEX)) {
      const url = new URL(script);
      return {
        dapAgency: url.searchParams.get('agency'),
        dapSubAgency: url.searchParams.get('subagency'),
      };      
    }
  }
  return {
    dapAgency: null,
    dapSubAgency: null,
  };      
};

/**
 * Does the site have the adobe analytics script via launch?
 *
 * @param {*} scripts 
 */
const hasLaunchAdobeAnalytics = (scripts) => {
  return scripts.some(script => script.match(ADOBE_LAUNCH_ANALYTICS_REGEX));
};

/**
 * Does the site have the adobe analytics script via static?
 *
 * @param {*} scripts 
 */
const hasStaticAdobeAnalytics = (scripts) => {
  return scripts.some(script => script.match(STATIC_ANALYTICS_REGEX));
};

/**
 * Does the site have the adobe analytics script via a selfhosted file?
 *
 * This is a bit of a cheat in that we are looking for an s_code file,
 * but not one from static.cancer.gov. It should work, but it does
 * not mean their s_code is for OUR analytics.
 *
 * @param {*} scripts 
 */
const hasSelfHostedAdobeAnalytics = (scripts) => {
  return (
    !scripts.some(script => script.match(STATIC_ANALYTICS_REGEX)) &&
    scripts.some(script => script.match(SELF_HOSTED_ANALYTICS_REGEX))
  );
};

/**
 * Gets the information for a page/site and outputs a record.
 *
 * @param {Function} recordProcessor the record processor. 
 * @returns an async function to process a URL.
 */
const processPage = (recordProcessor) => async (url) => {

  process.stderr.write(`Beginning Processing ${url}.\n`);

  try {
    const {
      requestedUrl,
      finalUrl,
      scripts
    } = await getScriptsFromPage(url);

    const launchInfo = await getLaunchInfo(scripts);

    process.stderr.write(`Finished Processing ${url}.\n`);

    const record = {
      requestedUrl,
      finalUrl,
      ...launchInfo,
      hasDap: hasDap(scripts),
      ...getDapInfo(scripts),
      hasLaunchAdobeAnalytics: hasLaunchAdobeAnalytics(scripts),
      hasStaticAdobeAnalytics: hasStaticAdobeAnalytics(scripts),
      hasSelfHostedAdobeAnalytics: hasSelfHostedAdobeAnalytics(scripts),
    };
    recordProcessor(record);
    // Let's just return the record in case we want it in the future. We are
    // being called from a "map" function after all.
    return record;
  } catch (err) {
    process.stderr.write(`Finished Processing ${url} with Error.\n`);
    console.log(err);
    const record = {
      requestedUrl: url,
      errorMsg: err.message,
    };
    recordProcessor(record);
    return record;
  }
};

/**
 * This is the bulk of the 
 */
const program = async (urls, outputStream) => {

  const headers = [
    'requestedUrl', 'finalUrl', 'launchIsLegacyDTM', 'launchOrgId', 'launchPropertyId',
    'launchEnvironmentId', 'launchIsProduction', 'launchIsMinified', 'hasDap', 'dapAgency',
    'dapSubAgency', 'hasLaunchAdobeAnalytics', 'hasStaticAdobeAnalytics',
    'hasSelfHostedAdobeAnalytics', 'errorMsg',
  ];

  outputStream.write(headers.join(',') + '\n');

  // Iterate over URLs processing the pages. processPage takes a callback that defined how
  // the record should be processed. The record needs to be turned into an array of the
  // values, indexed against the header row to have a sane order.
  //
  // FYI There is no pEach, so this "map" will have a side effect where it will output a
  // row for each URL. We do not really care about the records at the end.
  await pMap(
    urls, 
    processPage((record) => {
      const row = headers.map( 
        key => { 
          if (record[key] === true) {
            return 'yes';
          } else if (record[key] === false) {
            return 'no';
          } else {
            return record[key];
          } 
        }
      );
      outputStream.write(row.join(',') + '\n');
    }), 
    { concurrency: 2 }
  );

  // By this point all the URLs will be processed and the CSV will have been outputted.
};

/**
 * Main function
 */
(async () => {

  const cli = meow(`
    Usage
      $ node index.js <input_file>
    
    Options
      --output, -o  Output file
    
    Examples
      $ node index.js --output output.csv ./urls.txt
  `, {
    importMeta: import.meta,
    flags: {
      output: {
        type: 'string',
        shortFlag: 'o',
        isMultiple: false,
        isRequired: false,
      },
    },
  });

  if (cli.input.length !== 1) {
    cli.showHelp();
  }

  const filePath = cli.input.at(0);
  const fullPath = filePath.startsWith('/') ?
    filePath :
    path.normalize(path.join(process.cwd(), filePath));

  const urls = readFileSync(fullPath, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s !== '');

  const outputStream = cli.flags['output'] ? 
    createWriteStream(
      cli.flags['output'].startsWith('/') ? cli.flags['output'] : path.normalize(path.join(process.cwd(), cli.flags['output']))
    ) :
    process.stdout;

  try {
    await program(urls, outputStream);
  } finally {
    if (cli.flags['output']) {
      outputStream.end();
    }
  }

})();