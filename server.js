const MASCARA_SUPPORT = process.env.MASCARA_SUPPORT;
const PORT = process.env.PORT || 9000;

const express = require('express');
const Browserify = require('browserify');
const envify = require('envify/custom');
const bodyParser = require('body-parser');
const cors = require('cors');
const RateLimit = require('express-rate-limit');
const EthQuery = require('ethjs-query');
const BN = require('bn.js');
const ethUtil = require('ethereumjs-util');
const config = require('./get-config');
const rpcWrapperEngine = require('./index.js');
const regularPageCode = require('fs').readFileSync('./index.html', 'utf-8');
const mascaraPageCode = require('fs').readFileSync('./zero.html', 'utf-8');
const pageCode = MASCARA_SUPPORT ? mascaraPageCode : regularPageCode;
const cache = require('memory-cache');

const ETHER = 1e18;
const FIFTEEN_MIN = 15 * 60 * 1000;
const FAUCET_AMOUNT = (1 * ETHER);
const TEN_ETH = new BN('10000000000000000000', 10);

console.log('Acting as faucet for address:', config.address);

// Lazy nonce tracking fix:
// Force an exit after ten minutes (docker will trigger a restart)
// setTimeout(() => {
//   console.log('Restarting for better nonce tracking');
//   process.exit();
// }, 10 * 60 * 1000);

//
// create engine
//

// ProviderEngine based caching layer, with fallback to geth
const engine = rpcWrapperEngine({
  rpcUrl: config.rpcOrigin,
  addressHex: config.address,
  privateKey: ethUtil.toBuffer(config.privateKey),
});

const ethQuery = new EthQuery(engine);

// prepare app bundle
const browserify = Browserify();
// inject faucet address
browserify.transform(envify({
  FAUCET_ADDRESS: config.address,
}));
// build app
browserify.add('./app.js');
browserify.bundle(function(err, bundle) {
  if (err) {
    throw err;
  }
  const appCode = bundle.toString();
  startServer(appCode);
});

//
// create webserver
//
function startServer(appCode) {
  const app = express();
  app.use(cors());
  app.use(bodyParser.text({type: '*/*'}));

  // serve app
  app.get('/', deliverPage);
  app.get('/index.html', deliverPage);
  app.get('/app.js', deliverApp);

  // send ether
  app.enable('trust proxy');
  // add IP-based rate limiting
  app.post('/', new RateLimit({
             // 15 minutes
             windowMs: FIFTEEN_MIN,
             // limit each IP to N requests per windowMs
             max: 200,
           }));
  // the fauceting request
  app.post('/', function(req, res) {
    // parse request
    let targetAddress = req.body;
    if (targetAddress.slice(0, 2) !== '0x') {
      targetAddress = '0x' + targetAddress;
    }
    if (targetAddress.length !== 42) {
      didError(new Error('Address parse failure - ' + targetAddress));
      return;
    }

    const greedy = new Error('User is greedy.');
    const cachedBalance = cache.get(targetAddress);
    if (cachedBalance && cachedBalance.gt(TEN_ETH)) {
      didError(greedy);
      return;
    }
    // check for greediness
    ethQuery.getBalance(targetAddress, 'pending')
        .then(function(balance) {
          const balanceTooFull = balance.gt(TEN_ETH);
          if (balanceTooFull) {
            cache.put(targetAddress, balance, FIFTEEN_MIN);
            didError(greedy);
            return;
          }

          ethQuery.gasPrice()
              .then(function(price) {
                const adjustedPrice = Math.max(Number(price), 2e9);
                // send value
                ethQuery
                    .sendTransaction({
                      to: targetAddress,
                      from: config.address,
                      value: FAUCET_AMOUNT,
                      data: '',
                      gasPrice: adjustedPrice
                    })
                    .then(function(result) {
                      console.log('sent tx:', result);
                      cache.put(
                          targetAddress,
                          balance.add(new BN(String(FAUCET_AMOUNT), 10)),
                          FIFTEEN_MIN);
                      res.send(result);
                    })
                    .catch(didError);
              })
              .catch(didError);
        })
        .catch(didError);

    function didError(err) {
      console.error(err.stack);
      res.status(500).json({error: err.message});
    }

    function invalidRequest() {
      res.status(400).json({error: 'Not a valid request.'});
    }
  });

  app.listen(PORT, function() {
    console.log('ethereum rpc listening on', PORT);
    console.log('and proxying to', config.rpcOrigin);
  });

  function deliverPage(req, res) {
    res.status(200).send(pageCode);
  }

  function deliverApp(req, res) {
    res.status(200).send(appCode);
  }
}
