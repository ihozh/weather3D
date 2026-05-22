#include "WeatherTwinRootActor.h"

#include "Components/SceneComponent.h"
#include "Engine/World.h"
#include "Kismet/GameplayStatics.h"
#include "WeatherTwinCloudVolumeActor.h"
#include "WeatherTwinStationsActor.h"
#include "WeatherTwinTerrainActor.h"
#include "WeatherTwinWindTrailsActor.h"

AWeatherTwinRootActor::AWeatherTwinRootActor()
{
    PrimaryActorTick.bCanEverTick = false;
    RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

template<typename T>
T* AWeatherTwinRootActor::SpawnLayer(const TCHAR* Name)
{
    FActorSpawnParameters Params;
    Params.Name = MakeUniqueObjectName(GetWorld(), T::StaticClass(), FName(Name));
    Params.Owner = this;
    T* Actor = GetWorld()->SpawnActorDeferred<T>(T::StaticClass(), GetActorTransform(), this, nullptr, ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
    if (Actor)
    {
        Actor->Region = Region;
        UGameplayStatics::FinishSpawningActor(Actor, GetActorTransform());
        Actor->AttachToActor(this, FAttachmentTransformRules::KeepWorldTransform);
    }
    return Actor;
}

void AWeatherTwinRootActor::BeginPlay()
{
    Super::BeginPlay();

    if (bSpawnTerrain)
    {
        SpawnLayer<AWeatherTwinTerrainActor>(TEXT("WeatherTwinTerrain"));
    }
    if (bSpawnStations)
    {
        SpawnLayer<AWeatherTwinStationsActor>(TEXT("WeatherTwinStations"));
    }
    if (bSpawnClouds)
    {
        SpawnLayer<AWeatherTwinCloudVolumeActor>(TEXT("WeatherTwinClouds"));
    }
    if (bSpawnWind)
    {
        SpawnLayer<AWeatherTwinWindTrailsActor>(TEXT("WeatherTwinWind"));
    }
}
