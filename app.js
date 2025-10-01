document.addEventListener('alpine:init', () => {
  Alpine.data('App', () => ({
    csvFile: null,
    csvRecords: null,

    columns: [],
    columnDate: null,
    columnConsumption: null,
    columnProduction: null,
    columnMeter: null,

    batteryCapacity: 13.8, // kWh
    batteryMaxChargeRate: 7, // kW
    batteryMaxDischargeRate: 7, // kW
    batteryInitialSoc: 30, // percentage

    batteryCost: 7500, // currency units
    tariffImport: 0.2673, // currency amount per kWh for import from grid
    tariffExport: 0.0640, // currency amount per kWh for export to grid

    dataset: null,

    dataMinDate: null,
    dataMaxDate: null,

    simulateFromDate: null,
    simulateUntilDate: null,

    showUpload: true,
    showConfig: false,
    showColumnsConfig: true,

    simulation: {},

    handleFileUpload(event) {
      this.csvFile = event.target.files[0];
      if (this.csvFile) {
        this.loadCSV();
      }
    },

    loadCSV() {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        parse(text, {
          columns: true,
          skip_empty_lines: true
        }, (err, records) => {
          if (err) {
            console.error("Error parsing CSV:", err);
          } else {
            this.csvRecords = records;
            this.columns = Object.keys(records[0]);
            this.columnDate = 'Date';
            this.columnConsumption = 'Consumption';
            this.columnProduction = 'Production';
            for (let col of this.columns) {
              if (col.toLowerCase().includes('meter')) {
                this.columnMeter = col;
                break;
              }
            }
            this.showConfig = true;
            this.showUpload = false;
          }
        });
      };
      reader.readAsText(this.csvFile);
    },

    parseData() {
      this.dataset = [];
      for (const record of this.csvRecords) {
        const date = new Date(record[this.columnDate]);
        if (this.dataMinDate === null || date < this.dataMinDate) {
          this.dataMinDate = date;
        }
        if (this.dataMaxDate === null || date > this.dataMaxDate) {
          this.dataMaxDate = date;
        }
        this.dataset.push({
          date: date,
          consumption: parseFloat(record[this.columnConsumption]),
          production: parseFloat(record[this.columnProduction]),
          meter: parseFloat(record[this.columnMeter]),
        })
      }
      this.simulateFromDate = this.isoDate(this.dataMinDate);
      this.simulateUntilDate = this.isoDate(this.dataMaxDate);

      setTimeout(() => {
        this.showColumnsConfig = false;
      }, 500);
    },

    runSimulation() {
      if (!this.dataset) {
        return;
      }

      this.simulation = {
        // cumulative totals
        originalEnergyImport: 0,
        originalEnergyExport: 0,
        withBatteryEnergyImport: 0,
        withBatteryEnergyExport: 0,
        // tracking current state
        currentDay: null,
        firstDate: null,
        lastDate: null,
        trackingDayCounter: 1,
        batterySoc: (this.batteryInitialSoc / 100) * this.batteryCapacity,
        batteryCharge: 0, // in kW
        batteryDischarge: 0, // in kW
        // Average minimum and maximum SoC througout the dataset
        batteryMinAvg: this.batteryCapacity,
        batteryMaxAvg: 0,
      };

      let dailyBatteryMin = this.batteryCapacity, dailyBatteryMax = 0;
      let previousDataPoint = null;


      const minDate = new Date(this.simulateFromDate);
      const maxDate = new Date(this.simulateUntilDate);
      maxDate.setHours(23, 59, 59);
      console.log(minDate, maxDate);

      for (const dataPoint of this.dataset) {
        if (!previousDataPoint || dataPoint.date < minDate || dataPoint.date > maxDate) {
          previousDataPoint = dataPoint;
          continue;
        }

        if (this.simulation.currentDay === null) {
          this.simulation.currentDay = this.isoDate(dataPoint.date);
          this.simulation.firstDate = dataPoint.date;
        } else if (this.isoDate(dataPoint.date) !== this.simulation.currentDay) {
          // New day, track min/max SoC for previous day
          this.simulation.currentDay = this.isoDate(dataPoint.date);
          this.simulation.trackingDayCounter += 1;

          this.simulation.batteryMinAvg = (
            this.simulation.batteryMinAvg * (this.simulation.trackingDayCounter - 1) + dailyBatteryMin
          ) / this.simulation.trackingDayCounter;
          this.simulation.batteryMaxAvg = (
            this.simulation.batteryMaxAvg * (this.simulation.trackingDayCounter - 1) + dailyBatteryMax
          ) / this.simulation.trackingDayCounter;

          dailyBatteryMin = this.batteryCapacity;
          dailyBatteryMax = 0;

        } else {
          // Same day, update daily min/max
          dailyBatteryMin = Math.min(dailyBatteryMin, this.simulation.batterySoc);
          dailyBatteryMax = Math.max(dailyBatteryMax, this.simulation.batterySoc);
        }

        // Calculate
        const deltaSeconds = (dataPoint.date - previousDataPoint.date) / 1000;
        const meterEnergy = (dataPoint.meter * deltaSeconds) / 3600 / 1000; // kWh

        // Track original import/export values
        if (meterEnergy > 0) {
          // Import from grid
          this.simulation.originalEnergyImport += meterEnergy;
        } else {
          // Export to grid
          this.simulation.originalEnergyExport -= meterEnergy;
        }

        // Track hypothetical import/export with battery
        if (meterEnergy > 0) {
          // Import from grid, discharge battery if possible
          const maxBatteryDischarge = this.batteryMaxDischargeRate * deltaSeconds / 3600;
          const batteryDischarge = Math.min(maxBatteryDischarge, meterEnergy, this.simulation.batterySoc);
          this.simulation.batterySoc -= batteryDischarge;
          this.simulation.withBatteryEnergyImport += (meterEnergy - batteryDischarge);
        } else {
          // Export to grid, charge battery if possible
          const maxBatteryCharge = this.batteryMaxChargeRate * deltaSeconds / 3600;
          const batteryCharge = Math.min(maxBatteryCharge, -meterEnergy, this.batteryCapacity - this.simulation.batterySoc);
          this.simulation.batterySoc += batteryCharge;
          this.simulation.withBatteryEnergyExport -= meterEnergy + batteryCharge;
        }

        // Continue processing
        this.simulation.lastDate = dataPoint.date;
        previousDataPoint = dataPoint;
      }
    },

    get costWithoutBattery() {
      return this.simulation.originalEnergyImport * this.tariffImport - this.simulation.originalEnergyExport * this.tariffExport;
    },
    get costWithBattery() {
      return this.simulation.withBatteryEnergyImport * this.tariffImport - this.simulation.withBatteryEnergyExport * this.tariffExport;
    },

    numberFormat(value) {
      return new Intl.NumberFormat('de-CH', { maximumFractionDigits: 2 }).format(value);
    },

    currencyFormat(value) {
      return new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF' }).format(value);
    },

    dateFormat(value) {
      return new Intl.DateTimeFormat('de-CH', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
    },

    isoDate(value) {
      if (!value) return null;
      return value.toISOString().substring(0, 10);
    }

  }));
});
