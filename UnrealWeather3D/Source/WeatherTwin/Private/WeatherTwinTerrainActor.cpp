#include "WeatherTwinTerrainActor.h"

#include "ProceduralMeshComponent.h"
#include "WeatherTwinGeo.h"

AWeatherTwinTerrainActor::AWeatherTwinTerrainActor()
{
    PrimaryActorTick.bCanEverTick = false;
    Mesh = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("TerrainMesh"));
    RootComponent = Mesh;
}

void AWeatherTwinTerrainActor::OnConstruction(const FTransform& Transform)
{
    Super::OnConstruction(Transform);
    BuildTerrain();
}

void AWeatherTwinTerrainActor::BuildTerrain()
{
    const int32 Columns = SegmentsX + 1;
    const int32 Rows = SegmentsY + 1;

    TArray<FVector> Vertices;
    TArray<int32> Triangles;
    TArray<FVector> Normals;
    TArray<FVector2D> UVs;
    TArray<FColor> Colors;
    TArray<FProcMeshTangent> Tangents;

    Vertices.Reserve(Columns * Rows);
    UVs.Reserve(Columns * Rows);
    Colors.Reserve(Columns * Rows);

    for (int32 Row = 0; Row < Rows; ++Row)
    {
        const double V = static_cast<double>(Row) / SegmentsY;
        const double Latitude = Region.North - (Region.North - Region.South) * V;
        for (int32 Column = 0; Column < Columns; ++Column)
        {
            const double U = static_cast<double>(Column) / SegmentsX;
            const double Longitude = Region.West + (Region.East - Region.West) * U;
            const float HeightCm = WeatherTwinGeo::ElevationToHeightCm(WeatherTwinGeo::ProceduralElevationMeters(Longitude, Latitude));
            FVector P = WeatherTwinGeo::ToWorld(Longitude, Latitude, Region, HeightCm);
            Vertices.Add(P);
            UVs.Add(FVector2D(U, V));

            const float Coast = FMath::Clamp(static_cast<float>((Latitude - 30.25) / 1.15), 0.0f, 1.0f);
            const FLinearColor Field(0.44f, 0.53f, 0.25f);
            const FLinearColor Forest(0.12f, 0.28f, 0.15f);
            Colors.Add(FLinearColor::LerpUsingHSV(Field, Forest, 0.35f + Coast * 0.45f).ToFColor(true));
        }
    }

    for (int32 Row = 0; Row < SegmentsY; ++Row)
    {
        for (int32 Column = 0; Column < SegmentsX; ++Column)
        {
            const int32 A = Row * Columns + Column;
            const int32 B = A + 1;
            const int32 C = A + Columns;
            const int32 D = C + 1;
            Triangles.Append({A, C, B, B, C, D});
        }
    }

    Mesh->ClearAllMeshSections();
    Mesh->CreateMeshSection(0, Vertices, Triangles, Normals, UVs, Colors, Tangents, true);
    if (TerrainMaterial)
    {
        Mesh->SetMaterial(0, TerrainMaterial);
    }
}
