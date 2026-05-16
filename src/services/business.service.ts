import { env } from '../config/env';
import type { BusinessData, BusinessInput, CoverageEstimate, HospitalCandidate } from '../types/business.types';
import type { CustomerContext } from '../types/chat.types';
import type { ConsultationRecord, CoverageRecord, HospitalNetworkRecord, PatientRecord, PlanRecord, SpecialtyRecord } from '../types/notion-model.types';
import { clampNumber, roundCurrency } from '../utils/json';
import type { NotionService } from './notion.service';

function normalizeSpecialtyName(value: string): string {
  return value.trim().toLowerCase();
}

function mapHospitalNetwork(record: HospitalNetworkRecord): HospitalCandidate {
  const nombre = typeof record.raw.Nombre === 'string' ? record.raw.Nombre : undefined;
  const ciudad = typeof record.raw.Ciudad === 'string' ? record.raw.Ciudad : undefined;
  const nivelAtencion = typeof record.raw.Nivel_Atencion === 'string' ? record.raw.Nivel_Atencion : undefined;

  return {
    pageId: record.hospital?.pageId ?? record.hospitalPageId ?? record.pageId,
    idHospital: record.hospital?.idHospital ?? record.hospitalPageId ?? record.idRed,
    nombre: record.hospital?.nombre ?? nombre,
    ciudad: record.hospital?.ciudad ?? ciudad,
    nivelAtencion: record.hospital?.nivelAtencion ?? nivelAtencion,
    activo: record.hospital?.activo,
    tarifaBase: record.tarifaBase,
    latitud: record.hospital?.latitud as number | undefined,
    longitud: record.hospital?.longitud as number | undefined,
    direccion: record.hospital?.direccion as string | undefined,
    contacto: record.hospital?.contacto as string | undefined,
    score: typeof record.tarifaBase === 'number' ? 100 - Math.min(record.tarifaBase / 10, 45) : 50,
    raw: record.raw,
  };
}

export class BusinessService {
  constructor(private readonly notionService: NotionService) {}

  public async fetchBusinessData(input: BusinessInput): Promise<BusinessData> {
    const patient = await this.notionService.findPatientByNumeroPoliza(input.numeroPoliza);
    const plan = patient?.planPageId ? await this.notionService.findPlanByPageId(patient.planPageId) : null;
    const specialty = await this.notionService.findSpecialtyByValue(input.analysis.specialty);
    const coverageRecord = plan && specialty ? await this.notionService.findCoverageByPlanAndSpecialty(plan.pageId, specialty.pageId) : null;
    const hospitalsNetwork = plan && specialty ? await this.notionService.findHospitalsBySpecialtyAndPlan(plan.pageId, specialty.pageId) : [];
    const hospitals = hospitalsNetwork.map(mapHospitalNetwork);
    const recommendedHospital = this.recommendHospital(hospitals, specialty, input.analysis.priority, coverageRecord);
    const coverage = this.calculateCoverage({
      patient,
      plan,
      specialty,
      coverageRecord,
      priority: input.analysis.priority,
      customerContext: input.customerContext,
    });
    const consultation = input.consultationPageId
      ? {
          pageId: input.consultationPageId,
          idConsulta: input.consultationPageId,
          estadoConsulta: 'Abierta',
        }
      : await this.notionService.createConsultationRecord({
          numeroPoliza: input.numeroPoliza,
          patientPageId: patient?.pageId,
          specialtyPageId: specialty?.pageId,
          hospitalPageId: recommendedHospital?.pageId,
          copagoEstimado: coverage.estimatedCopay,
          sintomaIngresado: input.symptomText,
          estadoConsulta: 'Abierta',
        });

    return {
      numeroPoliza: input.numeroPoliza,
      patient: patient
        ? {
            pageId: patient.pageId,
            numeroPoliza: patient.numeroPoliza,
            nombreCompleto: patient.nombreCompleto,
            planPageId: patient.planPageId,
          }
        : null,
      plan: plan
        ? {
            pageId: plan.pageId,
            idPlan: plan.idPlan,
            nombrePlan: plan.nombrePlan,
            aseguradora: plan.aseguradora,
            tipoPlan: plan.tipoPlan,
            deducibleAnual: plan.deducibleAnual,
            coaseguroPct: plan.coaseguroPct,
            maxBolsilloAnual: plan.maxBolsilloAnual,
            activo: plan.activo,
          }
        : null,
      specialty: specialty
        ? {
            pageId: specialty.pageId,
            idEspecialidad: specialty.idEspecialidad,
            nombre: specialty.nombre,
            sintomasRelacionados: specialty.sintomasRelacionados,
            urgenciaBase: specialty.urgenciaBase,
            requiereReferido: specialty.requiereReferido,
          }
        : null,
      coverageRecord: coverageRecord
        ? {
            pageId: coverageRecord.pageId,
            idCobertura: coverageRecord.idCobertura,
            copagoFijo: coverageRecord.copagoFijo,
            coaseguroOverride: coverageRecord.coaseguroOverride,
            cubierto: coverageRecord.cubierto,
          }
        : null,
      hospitals,
      recommendedHospital,
      coverage,
      decisionNotes: [
        `Poliza procesada: ${input.numeroPoliza}`,
        patient ? `Paciente encontrado: ${patient.nombreCompleto ?? patient.numeroPoliza}` : 'Paciente no encontrado en PACIENTES',
        plan ? `Plan detectado: ${plan.idPlan}` : 'No se encontró un plan asociado al paciente',
        specialty ? `Especialidad detectada: ${specialty.nombre ?? specialty.idEspecialidad}` : 'Especialidad no encontrada en ESPECIALIDADES',
        coverageRecord ? `Cobertura encontrada: ${coverageRecord.idCobertura}` : 'No hay cobertura específica para plan + especialidad',
        recommendedHospital ? `Hospital recomendado: ${recommendedHospital.nombre ?? recommendedHospital.idHospital}` : 'No hay hospital de red disponible',
      ],
      consultation: {
        pageId: consultation.pageId,
        idConsulta: consultation.idConsulta,
        estadoConsulta: consultation.estadoConsulta,
      },
    };
  }

  public calculateCoverage(input: {
    patient: PatientRecord | null;
    plan: PlanRecord | null;
    specialty: SpecialtyRecord | null;
    coverageRecord: CoverageRecord | null;
    priority: string;
    customerContext: Record<string, unknown>;
  }): CoverageEstimate {
    const deductibleFactor = input.plan?.deducibleAnual ? clampNumber(1 - input.plan.deducibleAnual / 20000, 0.25, 1) : 1;
    const planCoinsurance = typeof input.plan?.coaseguroPct === 'number' ? input.plan.coaseguroPct / 100 : 0.2;
    const overrideCoinsurance = typeof input.coverageRecord?.coaseguroOverride === 'number' ? input.coverageRecord.coaseguroOverride / 100 : null;
    const coveragePercentFromPlan = clampNumber(1 - planCoinsurance * deductibleFactor, 0.3, 0.98);
    const coveragePercent = input.coverageRecord?.cubierto === false
      ? 0.2
      : clampNumber(overrideCoinsurance ? 1 - overrideCoinsurance : coveragePercentFromPlan, 0.3, 0.98);

    const priorityAdjustment = input.priority === 'urgent' ? 1.1 : input.priority === 'high' ? 1.05 : 1;
    const estimatedServiceCost = this.estimateServiceCost(input.specialty?.nombre ?? input.specialty?.idEspecialidad ?? 'Medicina General') * priorityAdjustment;
    const copagoFijo = input.coverageRecord?.copagoFijo ?? 0;
    const estimatedCopay = roundCurrency(estimatedServiceCost * (1 - coveragePercent) + copagoFijo);

    return {
      coveragePercent,
      coverageLabel: `${Math.round(coveragePercent * 100)}% estimado`,
      estimatedServiceCost: roundCurrency(estimatedServiceCost),
      estimatedCopay: Math.max(0, estimatedCopay),
      currency: 'USD',
      notes: input.coverageRecord?.cubierto === false
        ? 'La cobertura específica indica que el caso no está cubierto por ese plan.'
        : 'Cobertura calculada usando PLANES_SEGURO + COBERTURAS_ESPECIALIDAD.',
    };
  }

  public recommendHospital(
    hospitals: HospitalCandidate[],
    specialty: SpecialtyRecord | null,
    priority: string,
    coverageRecord: CoverageRecord | null,
  ): HospitalCandidate | null {
    if (hospitals.length === 0) {
      return null;
    }

    const normalizedSpecialty = normalizeSpecialtyName(specialty?.nombre ?? specialty?.idEspecialidad ?? '');

    return hospitals
      .map((hospital) => {
        let score = hospital.score ?? 50;

        if (normalizedSpecialty && hospital.raw) {
          score += normalizedSpecialty.length > 0 ? 10 : 0;
        }

        if ((hospital.nivelAtencion ?? '').toLowerCase().includes('alta')) {
          score += 8;
        }

        if (priority === 'urgent') {
          score += 10;
        }

        if (coverageRecord?.cubierto === false) {
          score -= 15;
        }

        return {
          ...hospital,
          score,
        };
      })
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0] ?? null;
  }

  private estimateServiceCost(specialty: string): number {
    const normalized = normalizeSpecialtyName(specialty);

    if (normalized.includes('cardio')) return 320;
    if (normalized.includes('neuro')) return 350;
    if (normalized.includes('trauma') || normalized.includes('ortho')) return 280;
    if (normalized.includes('gastro')) return 230;
    if (normalized.includes('pulmo') || normalized.includes('respir')) return 210;
    if (normalized.includes('derma')) return 140;
    if (normalized.includes('pedi')) return 120;
    if (normalized.includes('gine') || normalized.includes('obst')) return 180;
    if (normalized.includes('urg')) return 500;
    return 180;
  }
}
