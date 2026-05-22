#include "WeatherTwinStationsActor.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SceneComponent.h"
#include "Components/TextRenderComponent.h"
#include "UObject/ConstructorHelpers.h"
#include "WeatherTwinGeo.h"

AWeatherTwinStationsActor::AWeatherTwinStationsActor()
{
    PrimaryActorTick.bCanEverTick = false;
    RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

    StationMarkers = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("StationMarkers"));
    StationMarkers->SetupAttachment(RootComponent);
    StationMasts = CreateDefaultSubobject<UInstancedStaticMeshComponent>(TEXT("StationMasts"));
    StationMasts->SetupAttachment(RootComponent);

    static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereMesh(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
    static ConstructorHelpers::FObjectFinder<UStaticMesh> CylinderMesh(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
    if (SphereMesh.Succeeded())
    {
        StationMarkers->SetStaticMesh(SphereMesh.Object);
    }
    if (CylinderMesh.Succeeded())
    {
        StationMasts->SetStaticMesh(CylinderMesh.Object);
    }

    PopulateDefaultStations();
}

void AWeatherTwinStationsActor::PopulateDefaultStations()
{
    if (!Stations.IsEmpty())
    {
        return;
    }

    auto Add = [&](const TCHAR* Name, double Lat, double Lon)
    {
        FMesonetStation Station;
        Station.Name = Name;
        Station.Latitude = Lat;
        Station.Longitude = Lon;
        Stations.Add(Station);
    };

    Add(TEXT("Agricola"), 30.82, -88.5);
    Add(TEXT("Andalusia"), 31.29, -86.5);
    Add(TEXT("Atmore"), 31.02, -87.4);
    Add(TEXT("Bay Minette"), 30.89, -87.8);
    Add(TEXT("Castleberry"), 31.30, -87.0);
    Add(TEXT("Dixie"), 31.16, -86.7);
    Add(TEXT("Elberta"), 30.41, -87.6);
    Add(TEXT("Fairhope"), 30.54, -87.9);
    Add(TEXT("Florala"), 31.00, -86.3);
    Add(TEXT("Foley"), 30.37, -87.6);
    Add(TEXT("Gasque"), 30.24, -87.9);
    Add(TEXT("Geneva"), 31.06, -85.8);
    Add(TEXT("Jay"), 30.95, -87.2);
    Add(TEXT("Kinston"), 31.22, -86.2);
    Add(TEXT("Leakesville"), 31.18, -88.6);
    Add(TEXT("Loxley"), 30.64, -87.7);
    Add(TEXT("Mobile DR"), 30.56, -88.1);
    Add(TEXT("Mobile USAW"), 30.69, -88.2);
    Add(TEXT("Saraland"), 30.83, -88.1);
}

void AWeatherTwinStationsActor::OnConstruction(const FTransform& Transform)
{
    Super::OnConstruction(Transform);
    StationMarkers->ClearInstances();
    StationMasts->ClearInstances();

    TArray<UTextRenderComponent*> ExistingLabels;
    GetComponents(ExistingLabels);
    for (UTextRenderComponent* Label : ExistingLabels)
    {
        Label->DestroyComponent();
    }

    for (const FMesonetStation& Station : Stations)
    {
        const float HeightCm = WeatherTwinGeo::ElevationToHeightCm(WeatherTwinGeo::ProceduralElevationMeters(Station.Longitude, Station.Latitude));
        const FVector P = WeatherTwinGeo::ToWorld(Station.Longitude, Station.Latitude, Region, HeightCm);

        StationMarkers->AddInstance(FTransform(FRotator::ZeroRotator, P + FVector(0, 0, 180.0f), FVector(4.0f)));
        StationMasts->AddInstance(FTransform(FRotator::ZeroRotator, P + FVector(0, 0, 310.0f), FVector(0.18f, 0.18f, 5.5f)));

        UTextRenderComponent* Label = NewObject<UTextRenderComponent>(this);
        Label->RegisterComponent();
        Label->AttachToComponent(RootComponent, FAttachmentTransformRules::KeepRelativeTransform);
        Label->SetText(FText::FromString(Station.Name));
        Label->SetHorizontalAlignment(EHTA_Center);
        Label->SetWorldSize(280.0f);
        Label->SetTextRenderColor(FColor(244, 211, 94));
        Label->SetRelativeLocation(P + FVector(0, 0, 760.0f));
        Label->SetRelativeRotation(FRotator(65.0f, 0.0f, 0.0f));
    }
}
