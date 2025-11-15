// =========================
// Datos de refrigerantes
// =========================

const GC = 32.174; // lbm·ft / (lbf·s²)

const REFRIGERANTS = {
    R134a: {
        nombre: "R134a",
        rho_vapor_lbft3: 0.30,
        rho_liquido_lbft3: 75.0,
        mu_vapor_lbfts: 2.5e-5,
        efecto_frigorifico_btulb: 70.0
    },
    R22: {
        nombre: "R22",
        rho_vapor_lbft3: 0.35,
        rho_liquido_lbft3: 66.0,
        mu_vapor_lbfts: 2.5e-5,
        efecto_frigorifico_btulb: 85.0
    },
    R410A: {
        nombre: "R410A",
        rho_vapor_lbft3: 0.40,
        rho_liquido_lbft3: 64.0,
        mu_vapor_lbfts: 2.3e-5,
        efecto_frigorifico_btulb: 75.0
    },
    R12: {
        nombre: "R12",
        rho_vapor_lbft3: 0.28,
        rho_liquido_lbft3: 80.0,
        mu_vapor_lbfts: 2.6e-5,
        efecto_frigorifico_btulb: 65.0
    }
};

// =========================
// Datos de tuberías de cobre
// =========================

function mmToIn(mm) {
    return mm / 25.4;
}

// nominal, diámetro exterior (mm), espesor de pared (mm)
const RAW_TUBES = [
    ["1/4", 6.35, 0.8],
    ["3/8", 9.52, 0.8],
    ["1/2", 12.7, 0.8],
    ["5/8", 15.87, 0.8],
    ["5/8", 15.87, 1.0],
    ["3/4", 19.06, 1.0],
    ["7/8", 22.22, 1.0],
    ["7/8", 22.22, 1.14],
    ["1", 25.4, 1.0],
    ["1 1/8", 28.57, 1.0],
    ["1 1/8", 28.57, 1.25],
    ["1 3/8", 34.92, 1.25],
    ["1 3/8", 34.92, 1.4],
    ["1 5/8", 41.27, 1.25],
    ["1 5/8", 41.27, 1.5],
    ["2 1/8", 53.97, 1.25],
    ["2 1/8", 53.97, 1.8],
    ["2 5/8", 66.67, 1.65],
    ["2 5/8", 66.67, 2.03],
    ["3 1/8", 79.37, 1.65],
    ["3 5/8", 92.08, 2.11],
    ["4 1/8", 104.78, 2.5]
];

const COPPER_TUBES = RAW_TUBES.map(([nominal, od_mm, wall_mm]) => {
    const od_in = mmToIn(od_mm);
    const wall_in = mmToIn(wall_mm);
    const id_in = od_in - 2 * wall_in;
    return { nominal, od_in, id_in, wall_mm };
}).sort((a, b) => a.od_in - b.od_in);

// =========================
// Funciones de cálculo
// =========================

function btuhToBtus(capacityBtuh) {
    return capacityBtuh / 3600.0;
}

function getRefrigerant(code) {
    const ref = REFRIGERANTS[code];
    if (!ref) {
        throw new Error("Refrigerante no soportado: " + code);
    }
    return ref;
}

function selectDensity(refCode, lineType) {
    const ref = getRefrigerant(refCode);
    return lineType === "liquido" ? ref.rho_liquido_lbft3 : ref.rho_vapor_lbft3;
}

function selectEffect(refCode) {
    const ref = getRefrigerant(refCode);
    return ref.efecto_frigorifico_btulb;
}

function selectViscosity(refCode /*, lineType*/) {
    const ref = getRefrigerant(refCode);
    return ref.mu_vapor_lbfts; // simplificación
}

function frictionFactor(Re) {
    if (Re <= 0) return 0.0;
    if (Re < 2300) {
        return 64.0 / Re; // laminar
    } else {
        return 0.3164 * Math.pow(Re, -0.25); // Blasius
    }
}

function dpToDT(lineType, dpPsi) {
    let factor;
    if (lineType === "succion") {
        factor = 1.0; // 1 psi ~ 1°F
    } else {
        factor = 0.5; // aprox.
    }
    return dpPsi * factor;
}

function computeMassFlow(capacityBtuh, refCode) {
    const qBtus = btuhToBtus(capacityBtuh); // BTU/s
    const efecto = selectEffect(refCode);   // BTU/lb
    if (efecto <= 0) {
        throw new Error("Efecto frigorífico no válido.");
    }
    return qBtus / efecto; // lb/s
}

function computeForTube(input, tube) {
    const rho = selectDensity(input.refrigerant, input.lineType);
    const mu = selectViscosity(input.refrigerant, input.lineType);
    const mDot = computeMassFlow(input.capacity, input.refrigerant); // lb/s

    const diameterFt = tube.id_in / 12.0;
    const areaFt2 = Math.PI * Math.pow(diameterFt, 2) / 4.0;

    let velFps = 0;
    if (areaFt2 > 0) {
        velFps = (mDot / rho) / areaFt2;
    }
    const velFtMin = velFps * 60.0;

    const Re = mu > 0 ? (rho * velFps * diameterFt) / mu : 0.0;
    const f = frictionFactor(Re);

    const L = Math.max(input.lengthEq, 0.01);
    const dpLbfFt2 = f * (L / diameterFt) * (rho * velFps * velFps) / (2.0 * GC);
    const dpPsi = dpLbfFt2 / 144.0;
    const dTF = dpToDT(input.lineType, dpPsi);

    // Advertencias
    const warnings = [];
    const velMs = (velFtMin / 60.0) * 0.3048;

    if (input.lineType === "succion" || input.lineType === "descarga") {
        if (input.heightVert > 0) {
            // tramo vertical
            if (velMs < 8.0) {
                warnings.push("Velocidad en tramo vertical menor a 8 m/s: posible problema de retorno de aceite.");
            } else if (velMs > 12.0) {
                warnings.push("Velocidad en tramo vertical mayor a 12 m/s: posible ruido y alta caída de presión.");
            }
        } else {
            if (velMs < 4.0) {
                warnings.push("Velocidad en tramo horizontal menor a 4 m/s: retorno de aceite insuficiente.");
            }
        }
    } else if (input.lineType === "liquido") {
        if (velFtMin > 300.0) {
            warnings.push("Velocidad en línea de líquido mayor a 300 ft/min: aumenta la caída de presión y riesgo de flasheo.");
        }
    }

    return {
        tube,
        velocityFtMin: velFtMin,
        deltaPPsi: dpPsi,
        deltaTF: dTF,
        Re,
        warnings
    };
}

function sizeLine(input) {
    const results = COPPER_TUBES.map(tube => computeForTube(input, tube));

    let selected = null;

    for (const res of results) {
        const dTlimit = (input.lineType === "liquido") ? 1.0 : 2.0;
        const okDeltaT = res.deltaTF <= dTlimit;

        const velMs = (res.velocityFtMin / 60.0) * 0.3048;
        let okVel = true;

        if (input.lineType === "succion" || input.lineType === "descarga") {
            if (input.heightVert > 0) {
                okVel = velMs >= 8.0 && velMs <= 12.0;
            } else {
                okVel = velMs >= 4.0;
            }
        } else if (input.lineType === "liquido") {
            okVel = res.velocityFtMin <= 300.0;
        }

        if (okDeltaT && okVel) {
            selected = res;
            break;
        }
    }

    return { results, selected };
}

// =========================
// Manejo de la interfaz
// =========================

function formatNumber(value, decimals) {
    return value.toFixed(decimals);
}

function mostrarErrores(msg) {
    const div = document.getElementById("errors");
    if (!msg) {
        div.classList.add("hidden");
        div.textContent = "";
        return;
    }
    div.classList.remove("hidden");
    div.textContent = msg;
}

function renderResultados(results, selected) {
    const tbody = document.getElementById("tabla-body");
    tbody.innerHTML = "";

    results.forEach(res => {
        const tr = document.createElement("tr");

        if (selected &&
            res.tube.nominal === selected.tube.nominal &&
            Math.abs(res.tube.id_in - selected.tube.id_in) < 1e-6) {
            tr.classList.add("row-selected");
        }

        const cNom = document.createElement("td");
        cNom.textContent = res.tube.nominal;

        const cOD = document.createElement("td");
        cOD.textContent = formatNumber(res.tube.od_in, 3);

        const cID = document.createElement("td");
        cID.textContent = formatNumber(res.tube.id_in, 3);

        const cVel = document.createElement("td");
        cVel.textContent = formatNumber(res.velocityFtMin, 1);

        const cDP = document.createElement("td");
        cDP.textContent = formatNumber(res.deltaPPsi, 3);

        const cDT = document.createElement("td");
        cDT.textContent = formatNumber(res.deltaTF, 3);

        const cRe = document.createElement("td");
        cRe.textContent = formatNumber(res.Re, 0);

        tr.appendChild(cNom);
        tr.appendChild(cOD);
        tr.appendChild(cID);
        tr.appendChild(cVel);
        tr.appendChild(cDP);
        tr.appendChild(cDT);
        tr.appendChild(cRe);

        tbody.appendChild(tr);
    });

    document.getElementById("resultados-card").classList.remove("hidden");
}

function renderSeleccion(selected, lineType) {
    const cont = document.getElementById("seleccion-contenido");
    const card = document.getElementById("seleccion-card");

    if (!selected) {
        cont.innerHTML = `
            <p>No se encontró un diámetro que cumpla simultáneamente
            los criterios de ΔT y velocidad. Revise longitud equivalente,
            capacidad o criterios de diseño.</p>
        `;
        card.classList.remove("hidden");
        return;
    }

    const velMs = (selected.velocityFtMin / 60.0) * 0.3048;

    let html = `
        <p><strong>Tubería seleccionada:</strong>
            ${selected.tube.nominal}&nbsp; (OD ≈ ${formatNumber(selected.tube.od_in, 3)} in,
            ID ≈ ${formatNumber(selected.tube.id_in, 3)} in)
        </p>
        <ul>
            <li>Velocidad ≈ ${formatNumber(selected.velocityFtMin, 1)} ft/min
                (${formatNumber(velMs, 2)} m/s)
            </li>
            <li>Caída de presión ≈ ${formatNumber(selected.deltaPPsi, 3)} psi</li>
            <li>Pérdida de temperatura equivalente ≈ ${formatNumber(selected.deltaTF, 3)} °F</li>
            <li>Número de Reynolds ≈ ${formatNumber(selected.Re, 0)}</li>
        </ul>
    `;

    const warnings = selected.warnings || [];
    if (warnings.length > 0) {
        html += `<div class="alert alert-warning"><strong>Advertencias:</strong><ul>`;
        warnings.forEach(w => {
            html += `<li>${w}</li>`;
        });
        html += `</ul></div>`;
    } else {
        html += `<div class="alert alert-ok">
            No se detectaron advertencias básicas para velocidades ni ΔT en esta selección.
        </div>`;
    }

    // Comentario rápido según tipo de línea
    if (lineType === "liquido") {
        html += `<p>Recuerde verificar también el subenfriamiento disponible
                 y las pérdidas por altura para evitar flasheo en la línea de líquido.</p>`;
    } else if (lineType === "succion") {
        html += `<p>Verifique sifones, pendientes y posible necesidad de doble riser
                 si la carga parcial es muy baja.</p>`;
    }

    cont.innerHTML = html;
    card.classList.remove("hidden");
}

// =========================
// Inicialización
// =========================

document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("form-lineas");
    const btnLimpiar = document.getElementById("btn-limpiar");

    form.addEventListener("submit", (evt) => {
        evt.preventDefault();
        mostrarErrores("");

        try {
            const refrigerant = document.getElementById("refrigerant").value;
            const lineType = document.getElementById("line_type").value;

            const evapTemp = parseFloat(document.getElementById("evap_temp").value);
            const condTemp = parseFloat(document.getElementById("cond_temp").value);
            const liquidTemp = parseFloat(document.getElementById("liquid_temp").value);
            const lengthEq = parseFloat(document.getElementById("length_eq").value);
            const heightVert = parseFloat(document.getElementById("height_vert").value);
            const capacity = parseFloat(document.getElementById("capacity").value);

            if (isNaN(evapTemp) || isNaN(condTemp) || isNaN(liquidTemp) ||
                isNaN(lengthEq) || isNaN(heightVert) || isNaN(capacity)) {
                throw new Error("Todos los campos deben tener un valor numérico válido.");
            }

            const input = {
                refrigerant,
                lineType,       // "liquido" | "succion" | "descarga"
                evapTemp,
                condTemp,
                liquidTemp,
                lengthEq,
                heightVert,
                capacity
            };

            const { results, selected } = sizeLine(input);

            renderResultados(results, selected);
            renderSeleccion(selected, lineType);

        } catch (err) {
            console.error(err);
            mostrarErrores(err.message || String(err));
        }
    });

    btnLimpiar.addEventListener("click", () => {
        mostrarErrores("");
        document.getElementById("tabla-body").innerHTML = "";
        document.getElementById("seleccion-contenido").innerHTML = "";
        document.getElementById("resultados-card").classList.add("hidden");
        document.getElementById("seleccion-card").classList.add("hidden");
    });
});
