# Compute or Communicate?

### Website: https://sparclab.github.io/compute-comm/

This repository hosts an interactive website and the energy model behind it. The website asks one question about wearable AI: should a wearable run the first layers of its AI model before sending data to a phone or on-body hub, or should it send the raw sensor data and let the hub do all the computing?

The answer depends on how much the wireless link costs per transmitted bit. The website compares two links, Bluetooth Low Energy (BLE) and Wi-R, a body-coupled link that sends data through the body, for six wearable AI models on 19 microcontrollers (MCUs). Every number on it comes from an analytical energy model built from datasheets, MLPerf Tiny measurements and Ixana's public Wi-R power calculator. Nothing on the page is measured on hardware.

The website accompanies the paper *Compute or Communicate? A Break-Even Criterion for Splitting Wearable AI Between Microcontrollers and Body-Coupled Links* by Meghna Roy Chowdhury (Purdue University), Gourav Datta (Case Western Reserve University) and Shreyas Sen (Purdue University), currently under review.

## What is on the website

The page reads top to bottom:

1. **Summary.** The main finding in three numbers, with a figure showing where a model can be split and how a cheaper link moves the best split toward sending the raw input.
2. **Motivation.** Why wearables split their models today, and why a cheaper link can change that.
3. **Break-even condition.** A step-by-step derivation of when computing on the wearable saves energy, with a worked example that lists every number for SleepFM on the STM32U385.
4. **Interactive explorer.** Pick a model, an MCU and how often BLE keeps its connection alive, then compare BLE and Wi-R split by split. A slider below sets any link energy per bit and shows where computing first stops paying.
5. **Results.** All 114 model–MCU pairs, with the pairs in which computing on the wearable uses less energy than sending the raw input.
6. **Robustness.** How far each assumption can be off before a result changes.
7. **Assumptions.** Every fixed value and its source, including a screenshot of the Ixana calculator the Wi-R values come from.
8. **Full calculator.** Every setting, split and layer, for anyone who wants to check the details or try their own MCU, link or battery.
9. **Code and data, Cite, References.**

The page is a single HTML file. To use it offline, download `index.html` and open it in any browser.

## What is in this repository

```
index.html                     the website (the same page as the link above)
analysis/
  cost_model.js                the energy model; the website runs the same code
  model_profiles.json          per-layer data size, MACs, weights and memory of the six models
  reproduce.js                 evaluates all 114 pairs and the alternative settings
  results.json                 every split of every pair, at full precision
  paper_numbers.json           every number quoted in the paper, with plain names and units
  robustness.py                tolerance to parameter error, Monte Carlo, MLPerf Tiny comparison
  robustness.json
  sweeps.js                    BLE keep-alive interval, packet delivery, fp32 model
  sweeps.json
  mlperf_tiny_computed.csv     MLPerf Tiny results converted to energy per MAC
```

## Rerunning the numbers

The scripts need only Node.js and Python 3, with no packages to install. We tested them with Node.js 26.5 and Python 3.13.

```bash
git clone https://github.com/SparcLab/compute-comm.git
cd compute-comm
node analysis/reproduce.js      # writes results.json and paper_numbers.json
python3 analysis/robustness.py  # writes robustness.json
node analysis/sweeps.js         # writes sweeps.json
```

The three scripts run in a few seconds and overwrite the files in `analysis/`. A clean run reproduces them exactly, so `git status` shows no changes afterwards.

## Disclosure

The Wi-R values come from the public power calculator of Ixana, which makes Wi-R. S. Sen founded Ixana.

## Citation

```bibtex

```


